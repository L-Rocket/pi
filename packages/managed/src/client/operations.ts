// Remote *Operations factories: structural implementations of the coding-agent
// tool operation interfaces backed by a Sandbox Worker over RPC.
// Dependency direction is one-way: this package never imports coding-agent;
// these objects satisfy its *Operations interfaces structurally.
// See docs/managed-agents-interface-spec.md §5.2.

import { randomUUID } from "node:crypto";
import { readFile as fsReadFile, unlink as fsUnlink } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import {
	type BashExecResponse,
	type FindResponse,
	type FsAccessResponse,
	type FsReaddirResponse,
	type FsReadResponse,
	type FsStatResponse,
	type GrepResponse,
	SANDBOX_ENDPOINTS,
} from "../protocol/sandbox.ts";
import { type SandboxClient, SandboxRpcError } from "./sandbox-client.ts";

export interface RemoteOperationsOptions {
	/** Runtime workspace cwd. Tool paths under it are sent sandbox-relative. */
	cwd: string;
}

function toSandboxPath(cwd: string, absolutePath: string): string {
	if (absolutePath === cwd) return ".";
	const prefix = cwd.endsWith(sep) ? cwd : cwd + sep;
	if (absolutePath.startsWith(prefix)) return relative(cwd, absolutePath);
	return absolutePath;
}

function nodeError(code: string, message: string): Error {
	const error = new Error(message);
	(error as NodeJS.ErrnoException).code = code;
	return error;
}

function translateFsError(error: unknown): never {
	if (error instanceof SandboxRpcError) {
		if (error.code === "not_found") throw nodeError("ENOENT", error.message);
		if (error.code === "path_escape") throw nodeError("EACCES", error.message);
	}
	throw error;
}

// ---------------------------------------------------------------------------
// bash

export interface RemoteBashOperations {
	exec: (
		command: string,
		cwd: string,
		options: {
			onData: (data: Buffer) => void;
			signal?: AbortSignal;
			timeout?: number;
			env?: NodeJS.ProcessEnv;
		},
	) => Promise<{ exitCode: number | null }>;
}

export function createRemoteBashOperations(
	client: SandboxClient,
	options: RemoteOperationsOptions,
): RemoteBashOperations {
	return {
		async exec(command, cwd, execOptions) {
			const opId = randomUUID();
			const signal = execOptions.signal;

			const execPromise = client.call<BashExecResponse>(SANDBOX_ENDPOINTS.bashExec, {
				opId,
				command,
				cwd: toSandboxPath(options.cwd, cwd),
				timeout: execOptions.timeout,
				// Runtime process env is never forwarded; the worker applies its own
				// whitelist scrub (interface spec §3 env-scrub semantics).
			});

			let onAbort: (() => void) | undefined;
			const abortPromise = new Promise<never>((_, reject) => {
				if (!signal) return;
				onAbort = () => {
					client.call(SANDBOX_ENDPOINTS.bashCancel, { opId }).catch(() => {});
					reject(new Error("aborted"));
				};
				if (signal.aborted) onAbort();
				else signal.addEventListener("abort", onAbort, { once: true });
			});

			try {
				const response = await Promise.race([execPromise, abortPromise]);
				if (response.timedOut) {
					throw new Error(`timeout:${execOptions.timeout}`);
				}
				const stdout = Buffer.from(response.stdout, "base64");
				const stderr = Buffer.from(response.stderr, "base64");
				if (stdout.length > 0) execOptions.onData(stdout);
				if (stderr.length > 0) execOptions.onData(stderr);
				return { exitCode: response.exitCode };
			} finally {
				if (onAbort) signal?.removeEventListener("abort", onAbort);
			}
		},
	};
}

// ---------------------------------------------------------------------------
// fs building blocks shared by read/write/edit/ls

async function remoteReadFile(client: SandboxClient, cwd: string, path: string): Promise<Buffer> {
	try {
		const response = await client.call<FsReadResponse>(
			SANDBOX_ENDPOINTS.fsRead,
			{ path: toSandboxPath(cwd, path) },
			{ idempotent: true },
		);
		return Buffer.from(response.content, "base64");
	} catch (error) {
		translateFsError(error);
	}
}

async function remoteWriteFile(client: SandboxClient, cwd: string, path: string, content: string): Promise<void> {
	try {
		await client.call(SANDBOX_ENDPOINTS.fsWrite, {
			path: toSandboxPath(cwd, path),
			content: Buffer.from(content, "utf-8").toString("base64"),
		});
	} catch (error) {
		translateFsError(error);
	}
}

async function remoteAccess(client: SandboxClient, cwd: string, path: string, mode: number): Promise<void> {
	let response: FsAccessResponse;
	try {
		response = await client.call<FsAccessResponse>(
			SANDBOX_ENDPOINTS.fsAccess,
			{ path: toSandboxPath(cwd, path), mode },
			{ idempotent: true },
		);
	} catch (error) {
		translateFsError(error);
	}
	if (!response.ok) {
		throw nodeError("ENOENT", `ENOENT: no such file or directory, access '${path}'`);
	}
}

async function remoteExists(client: SandboxClient, cwd: string, path: string): Promise<boolean> {
	try {
		const response = await client.call<FsAccessResponse>(
			SANDBOX_ENDPOINTS.fsAccess,
			{ path: toSandboxPath(cwd, path) },
			{ idempotent: true },
		);
		return response.ok;
	} catch (error) {
		if (error instanceof SandboxRpcError && (error.code === "not_found" || error.code === "path_escape"))
			return false;
		throw error;
	}
}

async function remoteStat(client: SandboxClient, cwd: string, path: string): Promise<FsStatResponse> {
	try {
		return await client.call<FsStatResponse>(
			SANDBOX_ENDPOINTS.fsStat,
			{ path: toSandboxPath(cwd, path) },
			{ idempotent: true },
		);
	} catch (error) {
		translateFsError(error);
	}
}

// ---------------------------------------------------------------------------
// read

export interface RemoteReadOperations {
	readFile: (absolutePath: string) => Promise<Buffer>;
	access: (absolutePath: string) => Promise<void>;
	detectImageMimeType: (absolutePath: string) => Promise<string | null>;
}

export function createRemoteReadOperations(
	client: SandboxClient,
	options: RemoteOperationsOptions,
): RemoteReadOperations {
	return {
		readFile: (path) => remoteReadFile(client, options.cwd, path),
		access: (path) => remoteAccess(client, options.cwd, path, 4),
		detectImageMimeType: async (path) => {
			const buffer = await remoteReadFile(client, options.cwd, path);
			return detectSupportedImageMimeType(buffer);
		},
	};
}

// ---------------------------------------------------------------------------
// write

export interface RemoteWriteOperations {
	writeFile: (absolutePath: string, content: string) => Promise<void>;
	mkdir: (dir: string) => Promise<void>;
}

export function createRemoteWriteOperations(
	client: SandboxClient,
	options: RemoteOperationsOptions,
): RemoteWriteOperations {
	return {
		writeFile: (path, content) => remoteWriteFile(client, options.cwd, path, content),
		mkdir: async (dir) => {
			try {
				await client.call(SANDBOX_ENDPOINTS.fsMkdir, { path: toSandboxPath(options.cwd, dir), recursive: true });
			} catch (error) {
				translateFsError(error);
			}
		},
	};
}

// ---------------------------------------------------------------------------
// edit

export interface RemoteEditOperations {
	readFile: (absolutePath: string) => Promise<Buffer>;
	writeFile: (absolutePath: string, content: string) => Promise<void>;
	access: (absolutePath: string) => Promise<void>;
}

export function createRemoteEditOperations(
	client: SandboxClient,
	options: RemoteOperationsOptions,
): RemoteEditOperations {
	return {
		readFile: (path) => remoteReadFile(client, options.cwd, path),
		writeFile: (path, content) => remoteWriteFile(client, options.cwd, path, content),
		access: (path) => remoteAccess(client, options.cwd, path, 6),
	};
}

// ---------------------------------------------------------------------------
// ls

export interface RemoteLsOperations {
	exists: (absolutePath: string) => Promise<boolean>;
	stat: (absolutePath: string) => Promise<{ isDirectory: () => boolean }>;
	readdir: (absolutePath: string) => Promise<string[]>;
}

export function createRemoteLsOperations(client: SandboxClient, options: RemoteOperationsOptions): RemoteLsOperations {
	return {
		exists: (path) => remoteExists(client, options.cwd, path),
		stat: async (path) => {
			const s = await remoteStat(client, options.cwd, path);
			return { isDirectory: () => s.isDirectory };
		},
		readdir: async (path) => {
			try {
				const response = await client.call<FsReaddirResponse>(
					SANDBOX_ENDPOINTS.fsReaddir,
					{ path: toSandboxPath(options.cwd, path) },
					{ idempotent: true },
				);
				return response.entries.map((entry) => entry.name);
			} catch (error) {
				translateFsError(error);
			}
		},
	};
}

// ---------------------------------------------------------------------------
// grep

export interface GrepSearchParams {
	pattern: string;
	path: string;
	glob?: string;
	ignoreCase?: boolean;
	literal?: boolean;
	limit: number;
	signal?: AbortSignal;
}

export interface GrepSearchResult {
	matches: { filePath: string; lineNumber: number; lineText?: string }[];
	limitReached: boolean;
}

export interface RemoteGrepOperations {
	isDirectory: (absolutePath: string) => Promise<boolean>;
	readFile: (absolutePath: string) => Promise<string>;
	search: (params: GrepSearchParams) => Promise<GrepSearchResult>;
}

export function createRemoteGrepOperations(
	client: SandboxClient,
	options: RemoteOperationsOptions,
): RemoteGrepOperations {
	return {
		isDirectory: async (path) => {
			const s = await remoteStat(client, options.cwd, path);
			return s.isDirectory;
		},
		readFile: async (path) => (await remoteReadFile(client, options.cwd, path)).toString("utf-8"),
		search: async (params) => {
			const response = await client.call<GrepResponse>(
				SANDBOX_ENDPOINTS.grep,
				{
					pattern: params.pattern,
					path: toSandboxPath(options.cwd, params.path),
					glob: params.glob,
					ignoreCase: params.ignoreCase,
					literal: params.literal,
					limit: params.limit,
				},
				{ idempotent: true },
			);
			return {
				matches: response.matches.map((match) => ({
					filePath: join(params.path, match.path),
					lineNumber: match.lineNumber,
					lineText: match.line,
				})),
				limitReached: response.truncated,
			};
		},
	};
}

// ---------------------------------------------------------------------------
// find

export interface RemoteFindOperations {
	exists: (absolutePath: string) => Promise<boolean>;
	glob: (pattern: string, cwd: string, options: { ignore: string[]; limit: number }) => Promise<string[]>;
}

export function createRemoteFindOperations(
	client: SandboxClient,
	options: RemoteOperationsOptions,
): RemoteFindOperations {
	return {
		exists: (path) => remoteExists(client, options.cwd, path),
		glob: async (pattern, cwd, globOptions) => {
			const response = await client.call<FindResponse>(
				SANDBOX_ENDPOINTS.find,
				{
					pattern,
					path: toSandboxPath(options.cwd, cwd),
					ignore: globOptions.ignore,
					limit: globOptions.limit,
				},
				{ idempotent: true },
			);
			return response.paths.map((p) => join(cwd, p));
		},
	};
}

// ---------------------------------------------------------------------------
// bash overflow persistence

/**
 * Build a BashToolOptions.persistFullOutput hook that copies the runtime-local
 * overflow file into the sandbox under the workspace (the jail confines reads
 * to the workspace root, so the file must live there to stay reachable).
 * Returns the runtime-anchored absolute path presented to the model.
 */
export function createSandboxOverflowPersistence(
	client: SandboxClient,
	options: RemoteOperationsOptions & { dir?: string },
): (localPath: string) => Promise<string> {
	const dir = options.dir ?? ".pi/tool-output";
	return async (localPath: string) => {
		const content = await fsReadFile(localPath);
		const relativePath = `${dir}/${basename(localPath)}`;
		await client.call(SANDBOX_ENDPOINTS.fsMkdir, { path: dir, recursive: true });
		await client.call(SANDBOX_ENDPOINTS.fsWrite, { path: relativePath, content: content.toString("base64") });
		await fsUnlink(localPath).catch(() => {});
		return join(options.cwd, relativePath);
	};
}

// ---------------------------------------------------------------------------
// aggregate

export interface RemoteToolOperations {
	bash: RemoteBashOperations;
	read: RemoteReadOperations;
	write: RemoteWriteOperations;
	edit: RemoteEditOperations;
	ls: RemoteLsOperations;
	grep: RemoteGrepOperations;
	find: RemoteFindOperations;
}

export function createRemoteToolOperations(
	client: SandboxClient,
	options: RemoteOperationsOptions,
): RemoteToolOperations {
	return {
		bash: createRemoteBashOperations(client, options),
		read: createRemoteReadOperations(client, options),
		write: createRemoteWriteOperations(client, options),
		edit: createRemoteEditOperations(client, options),
		ls: createRemoteLsOperations(client, options),
		grep: createRemoteGrepOperations(client, options),
		find: createRemoteFindOperations(client, options),
	};
}

// ---------------------------------------------------------------------------
// image mime sniffing (mirrors coding-agent src/utils/mime.ts; duplicated
// because this package must not import coding-agent)

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function detectSupportedImageMimeType(buffer: Uint8Array): string | null {
	if (startsWith(buffer, [0xff, 0xd8, 0xff])) {
		return buffer[3] === 0xf7 ? null : "image/jpeg";
	}
	if (startsWith(buffer, PNG_SIGNATURE)) {
		return isPng(buffer) && !isAnimatedPng(buffer) ? "image/png" : null;
	}
	if (startsWithAscii(buffer, 0, "GIF")) {
		return "image/gif";
	}
	if (startsWithAscii(buffer, 0, "RIFF") && startsWithAscii(buffer, 8, "WEBP")) {
		return "image/webp";
	}
	if (startsWithAscii(buffer, 0, "BM") && isBmp(buffer)) {
		return "image/bmp";
	}
	return null;
}

function isPng(buffer: Uint8Array): boolean {
	return (
		buffer.length >= 16 && readUint32BE(buffer, PNG_SIGNATURE.length) === 13 && startsWithAscii(buffer, 12, "IHDR")
	);
}

function isAnimatedPng(buffer: Uint8Array): boolean {
	let offset = PNG_SIGNATURE.length;
	while (offset + 8 <= buffer.length) {
		const chunkLength = readUint32BE(buffer, offset);
		const chunkTypeOffset = offset + 4;
		if (startsWithAscii(buffer, chunkTypeOffset, "acTL")) return true;
		if (startsWithAscii(buffer, chunkTypeOffset, "IDAT")) return false;
		const nextOffset = offset + 8 + chunkLength + 4;
		if (nextOffset <= offset || nextOffset > buffer.length) return false;
		offset = nextOffset;
	}
	return false;
}

function isBmp(buffer: Uint8Array): boolean {
	if (buffer.length < 26) return false;
	const declaredFileSize = readUint32LE(buffer, 2);
	const pixelDataOffset = readUint32LE(buffer, 10);
	const dibHeaderSize = readUint32LE(buffer, 14);
	if (declaredFileSize !== 0 && declaredFileSize < 26) return false;
	if (pixelDataOffset < 14 + dibHeaderSize) return false;
	if (declaredFileSize !== 0 && pixelDataOffset >= declaredFileSize) return false;
	let colorPlanes: number;
	let bitsPerPixel: number;
	if (dibHeaderSize === 12) {
		colorPlanes = readUint16LE(buffer, 22);
		bitsPerPixel = readUint16LE(buffer, 24);
	} else if (dibHeaderSize >= 40 && dibHeaderSize <= 124) {
		if (buffer.length < 30) return false;
		colorPlanes = readUint16LE(buffer, 26);
		bitsPerPixel = readUint16LE(buffer, 28);
	} else {
		return false;
	}
	return colorPlanes === 1 && [1, 4, 8, 16, 24, 32].includes(bitsPerPixel);
}

function readUint16LE(buffer: Uint8Array, offset: number): number {
	return (buffer[offset] ?? 0) + ((buffer[offset + 1] ?? 0) << 8);
}

function readUint32BE(buffer: Uint8Array, offset: number): number {
	return (
		(buffer[offset] ?? 0) * 0x1000000 +
		((buffer[offset + 1] ?? 0) << 16) +
		((buffer[offset + 2] ?? 0) << 8) +
		(buffer[offset + 3] ?? 0)
	);
}

function readUint32LE(buffer: Uint8Array, offset: number): number {
	return (
		(buffer[offset] ?? 0) +
		((buffer[offset + 1] ?? 0) << 8) +
		((buffer[offset + 2] ?? 0) << 16) +
		(buffer[offset + 3] ?? 0) * 0x1000000
	);
}

function startsWith(buffer: Uint8Array, bytes: number[]): boolean {
	if (buffer.length < bytes.length) return false;
	return bytes.every((byte, index) => buffer[index] === byte);
}

function startsWithAscii(buffer: Uint8Array, offset: number, text: string): boolean {
	if (buffer.length < offset + text.length) return false;
	for (let index = 0; index < text.length; index++) {
		if (buffer[offset + index] !== text.charCodeAt(index)) return false;
	}
	return true;
}
