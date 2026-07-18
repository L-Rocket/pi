import { constants } from "node:fs";
import { access, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { RPC_ERROR_HTTP_STATUS, type RpcErrorCode, rpcError } from "../protocol/errors.ts";
import {
	type BashCancelRequest,
	type BashExecRequest,
	type FindRequest,
	type FsAccessRequest,
	type FsMkdirRequest,
	type FsReaddirRequest,
	type FsReadRequest,
	type FsStatRequest,
	type FsWriteRequest,
	type GrepRequest,
	isBashCancelRequest,
	isBashExecRequest,
	isFindRequest,
	isFsAccessRequest,
	isFsMkdirRequest,
	isFsReaddirRequest,
	isFsReadRequest,
	isFsStatRequest,
	isFsWriteRequest,
	isGrepRequest,
	SANDBOX_ENDPOINTS,
} from "../protocol/sandbox.ts";
import { ExecRegistry, OpConflictError } from "./exec.ts";
import { createJail, JailError } from "./jail.ts";
import { findFiles, grepSearch } from "./search.ts";

const MAX_BODY_BYTES = 64 * 1024 * 1024;
const MAX_READ_FILE_BYTES = 64 * 1024 * 1024;

class HttpError extends Error {
	readonly code: RpcErrorCode;

	constructor(code: RpcErrorCode, message: string) {
		super(message);
		this.name = "HttpError";
		this.code = code;
	}
}

async function readBody(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let bytes = 0;
	for await (const chunk of req) {
		const buffer = chunk as Buffer;
		bytes += buffer.length;
		if (bytes > MAX_BODY_BYTES) {
			throw new HttpError("payload_too_large", `Request body exceeds ${MAX_BODY_BYTES} bytes`);
		}
		chunks.push(buffer);
	}
	const text = Buffer.concat(chunks).toString("utf-8");
	try {
		return JSON.parse(text);
	} catch {
		throw new HttpError("bad_request", "Request body is not valid JSON");
	}
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body);
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(payload);
}

function sendError(res: ServerResponse, code: RpcErrorCode, message: string): void {
	sendJson(res, RPC_ERROR_HTTP_STATUS[code], rpcError(code, message));
}

function isNotFoundError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error.code === "ENOENT" || error.code === "ENOTDIR")
	);
}

async function isInsideGitRepo(searchPath: string): Promise<boolean> {
	for (let current = searchPath; ; ) {
		try {
			await access(join(current, ".git"), constants.F_OK);
			return true;
		} catch {
			// keep walking up
		}
		const parent = dirname(current);
		if (parent === current) return false;
		current = parent;
	}
}

export interface SandboxServerOptions {
	root: string;
}

export async function createSandboxServer(options: SandboxServerOptions): Promise<Server> {
	const jail = await createJail(options.root);
	const registry = new ExecRegistry();

	const server = createServer(async (req, res) => {
		try {
			if (req.method === "GET" && req.url === SANDBOX_ENDPOINTS.healthz) {
				sendJson(res, 200, { ok: true });
				return;
			}
			if (req.method !== "POST") {
				sendError(res, "not_found", `Unknown route: ${req.method} ${req.url}`);
				return;
			}

			switch (req.url) {
				case SANDBOX_ENDPOINTS.bashExec: {
					const body = await readBody(req);
					if (!isBashExecRequest(body)) throw new HttpError("bad_request", "Invalid BashExecRequest");
					const cwd = await jail.resolve((body as BashExecRequest).cwd);
					sendJson(res, 200, await registry.exec(body as BashExecRequest, cwd));
					return;
				}
				case SANDBOX_ENDPOINTS.bashCancel: {
					const body = await readBody(req);
					if (!isBashCancelRequest(body)) throw new HttpError("bad_request", "Invalid BashCancelRequest");
					sendJson(res, 200, { cancelled: registry.cancel((body as BashCancelRequest).opId) });
					return;
				}
				case SANDBOX_ENDPOINTS.fsRead: {
					const body = await readBody(req);
					if (!isFsReadRequest(body)) throw new HttpError("bad_request", "Invalid FsReadRequest");
					const path = await jail.resolve((body as FsReadRequest).path);
					const fileStat = await stat(path);
					if (fileStat.size > MAX_READ_FILE_BYTES) {
						throw new HttpError("payload_too_large", `File exceeds ${MAX_READ_FILE_BYTES} bytes`);
					}
					const content = await readFile(path);
					sendJson(res, 200, { content: content.toString("base64") });
					return;
				}
				case SANDBOX_ENDPOINTS.fsWrite: {
					const body = await readBody(req);
					if (!isFsWriteRequest(body)) throw new HttpError("bad_request", "Invalid FsWriteRequest");
					const path = await jail.resolve((body as FsWriteRequest).path);
					await writeFile(path, Buffer.from((body as FsWriteRequest).content, "base64"));
					sendJson(res, 200, {});
					return;
				}
				case SANDBOX_ENDPOINTS.fsMkdir: {
					const body = await readBody(req);
					if (!isFsMkdirRequest(body)) throw new HttpError("bad_request", "Invalid FsMkdirRequest");
					const path = await jail.resolve((body as FsMkdirRequest).path);
					await mkdir(path, { recursive: (body as FsMkdirRequest).recursive ?? true });
					sendJson(res, 200, {});
					return;
				}
				case SANDBOX_ENDPOINTS.fsAccess: {
					const body = await readBody(req);
					if (!isFsAccessRequest(body)) throw new HttpError("bad_request", "Invalid FsAccessRequest");
					const path = await jail.resolve((body as FsAccessRequest).path);
					try {
						await access(path, (body as FsAccessRequest).mode ?? constants.F_OK);
						sendJson(res, 200, { ok: true });
					} catch {
						sendJson(res, 200, { ok: false });
					}
					return;
				}
				case SANDBOX_ENDPOINTS.fsStat: {
					const body = await readBody(req);
					if (!isFsStatRequest(body)) throw new HttpError("bad_request", "Invalid FsStatRequest");
					const path = await jail.resolve((body as FsStatRequest).path);
					const s = await stat(path);
					sendJson(res, 200, {
						size: s.size,
						mtimeMs: s.mtimeMs,
						isFile: s.isFile(),
						isDirectory: s.isDirectory(),
					});
					return;
				}
				case SANDBOX_ENDPOINTS.fsReaddir: {
					const body = await readBody(req);
					if (!isFsReaddirRequest(body)) throw new HttpError("bad_request", "Invalid FsReaddirRequest");
					const path = await jail.resolve((body as FsReaddirRequest).path);
					const dirents = await readdir(path, { withFileTypes: true });
					sendJson(res, 200, {
						entries: dirents.map((d) => ({ name: d.name, isDirectory: d.isDirectory() })),
					});
					return;
				}
				case SANDBOX_ENDPOINTS.grep: {
					const body = await readBody(req);
					if (!isGrepRequest(body)) throw new HttpError("bad_request", "Invalid GrepRequest");
					const path = await jail.resolve((body as GrepRequest).path);
					sendJson(res, 200, await grepSearch(body as GrepRequest, path));
					return;
				}
				case SANDBOX_ENDPOINTS.find: {
					const body = await readBody(req);
					if (!isFindRequest(body)) throw new HttpError("bad_request", "Invalid FindRequest");
					const path = await jail.resolve((body as FindRequest).path);
					sendJson(res, 200, await findFiles(body as FindRequest, path, await isInsideGitRepo(path)));
					return;
				}
				default:
					sendError(res, "not_found", `Unknown route: ${req.method} ${req.url}`);
			}
		} catch (error) {
			if (error instanceof HttpError) {
				sendError(res, error.code, error.message);
			} else if (error instanceof JailError) {
				sendError(res, "path_escape", error.message);
			} else if (error instanceof OpConflictError) {
				sendError(res, "conflict", error.message);
			} else if (isNotFoundError(error)) {
				sendError(res, "not_found", error instanceof Error ? error.message : "Not found");
			} else {
				sendError(res, "internal", error instanceof Error ? error.message : "Internal error");
			}
		}
	});

	return server;
}
