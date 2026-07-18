// Sandbox Worker RPC protocol types and request validators.
// Wire format: HTTP/JSON request-response, binary content base64-encoded.
// See docs/managed-agents-interface-spec.md §3.

export interface BashExecRequest {
	opId: string;
	command: string;
	cwd: string;
	timeout?: number;
	env?: Record<string, string>;
}

export interface BashExecResponse {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	timedOut: boolean;
	stdoutTruncated?: boolean;
	stderrTruncated?: boolean;
}

export interface BashCancelRequest {
	opId: string;
}

export interface BashCancelResponse {
	cancelled: boolean;
}

export interface FsReadRequest {
	path: string;
}

export interface FsReadResponse {
	content: string;
}

export interface FsWriteRequest {
	path: string;
	content: string;
}

export interface FsMkdirRequest {
	path: string;
	recursive?: boolean;
}

export interface FsAccessRequest {
	path: string;
	mode?: number;
}

export interface FsAccessResponse {
	ok: boolean;
}

export interface FsStatRequest {
	path: string;
}

export interface FsStatResponse {
	size: number;
	mtimeMs: number;
	isFile: boolean;
	isDirectory: boolean;
}

export interface FsReaddirRequest {
	path: string;
}

export interface FsReaddirResponse {
	entries: { name: string; isDirectory: boolean }[];
}

export interface GrepRequest {
	pattern: string;
	path: string;
	glob?: string;
	ignoreCase?: boolean;
	literal?: boolean;
	context?: number;
	limit?: number;
}

export interface GrepMatch {
	path: string;
	lineNumber: number;
	line: string;
	before?: string[];
	after?: string[];
}

export interface GrepResponse {
	matches: GrepMatch[];
	truncated: boolean;
}

export interface FindRequest {
	pattern: string;
	path: string;
	limit?: number;
	ignore?: string[];
}

export interface FindResponse {
	paths: string[];
	truncated: boolean;
}

export const SANDBOX_ENDPOINTS = {
	bashExec: "/v1/bash/exec",
	bashCancel: "/v1/bash/cancel",
	fsRead: "/v1/fs/read",
	fsWrite: "/v1/fs/write",
	fsMkdir: "/v1/fs/mkdir",
	fsAccess: "/v1/fs/access",
	fsStat: "/v1/fs/stat",
	fsReaddir: "/v1/fs/readdir",
	grep: "/v1/grep",
	find: "/v1/find",
	healthz: "/v1/healthz",
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOptionalNumber(obj: Record<string, unknown>, key: string): boolean {
	return obj[key] === undefined || typeof obj[key] === "number";
}

function hasOptionalBoolean(obj: Record<string, unknown>, key: string): boolean {
	return obj[key] === undefined || typeof obj[key] === "boolean";
}

function hasOptionalString(obj: Record<string, unknown>, key: string): boolean {
	return obj[key] === undefined || typeof obj[key] === "string";
}

function hasPath(obj: Record<string, unknown>): boolean {
	return typeof obj.path === "string";
}

export function isBashExecRequest(value: unknown): value is BashExecRequest {
	if (!isRecord(value)) return false;
	if (typeof value.opId !== "string" || typeof value.command !== "string" || typeof value.cwd !== "string") {
		return false;
	}
	if (!hasOptionalNumber(value, "timeout")) return false;
	if (value.env !== undefined) {
		if (!isRecord(value.env)) return false;
		for (const v of Object.values(value.env)) {
			if (typeof v !== "string") return false;
		}
	}
	return true;
}

export function isBashCancelRequest(value: unknown): value is BashCancelRequest {
	return isRecord(value) && typeof value.opId === "string";
}

export function isFsReadRequest(value: unknown): value is FsReadRequest {
	return isRecord(value) && hasPath(value);
}

export function isFsWriteRequest(value: unknown): value is FsWriteRequest {
	return isRecord(value) && hasPath(value) && typeof value.content === "string";
}

export function isFsMkdirRequest(value: unknown): value is FsMkdirRequest {
	return isRecord(value) && hasPath(value) && hasOptionalBoolean(value, "recursive");
}

export function isFsAccessRequest(value: unknown): value is FsAccessRequest {
	return isRecord(value) && hasPath(value) && hasOptionalNumber(value, "mode");
}

export function isFsStatRequest(value: unknown): value is FsStatRequest {
	return isRecord(value) && hasPath(value);
}

export function isFsReaddirRequest(value: unknown): value is FsReaddirRequest {
	return isRecord(value) && hasPath(value);
}

export function isGrepRequest(value: unknown): value is GrepRequest {
	if (!isRecord(value)) return false;
	if (typeof value.pattern !== "string" || !hasPath(value)) return false;
	return (
		hasOptionalString(value, "glob") &&
		hasOptionalBoolean(value, "ignoreCase") &&
		hasOptionalBoolean(value, "literal") &&
		hasOptionalNumber(value, "context") &&
		hasOptionalNumber(value, "limit")
	);
}

export function isFindRequest(value: unknown): value is FindRequest {
	if (!isRecord(value)) return false;
	if (typeof value.pattern !== "string" || !hasPath(value) || !hasOptionalNumber(value, "limit")) return false;
	if (value.ignore !== undefined) {
		if (!Array.isArray(value.ignore)) return false;
		for (const entry of value.ignore) {
			if (typeof entry !== "string") return false;
		}
	}
	return true;
}
