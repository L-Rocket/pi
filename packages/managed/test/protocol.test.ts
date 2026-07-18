import { describe, expect, it } from "vitest";
import { isRpcError, RPC_ERROR_HTTP_STATUS, rpcError } from "../src/protocol/errors.ts";
import {
	type BashExecRequest,
	type FindRequest,
	type FsAccessRequest,
	type FsMkdirRequest,
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
} from "../src/protocol/sandbox.ts";

// Golden fixtures: one canonical JSON document per request type.
// Server and client both validate against these; a wire-breaking change
// (renamed/removed field) fails here before any endpoint test runs.
const fixtures: { name: string; validate: (v: unknown) => boolean; doc: unknown }[] = [
	{
		name: "BashExecRequest",
		validate: isBashExecRequest,
		doc: {
			opId: "op-1",
			command: "ls -la",
			cwd: ".",
			timeout: 30,
			env: { FOO: "bar" },
		} satisfies BashExecRequest,
	},
	{
		name: "BashExecRequest minimal",
		validate: isBashExecRequest,
		doc: { opId: "op-2", command: "pwd", cwd: "/" } satisfies BashExecRequest,
	},
	{
		name: "BashCancelRequest",
		validate: isBashCancelRequest,
		doc: { opId: "op-1" },
	},
	{
		name: "FsReadRequest",
		validate: isFsReadRequest,
		doc: { path: "src/index.ts" } satisfies FsReadRequest,
	},
	{
		name: "FsWriteRequest",
		validate: isFsWriteRequest,
		doc: { path: "a.bin", content: "aGVsbG8=" } satisfies FsWriteRequest,
	},
	{
		name: "FsMkdirRequest",
		validate: isFsMkdirRequest,
		doc: { path: "a/b", recursive: true } satisfies FsMkdirRequest,
	},
	{
		name: "FsAccessRequest",
		validate: isFsAccessRequest,
		doc: { path: "a.txt", mode: 4 } satisfies FsAccessRequest,
	},
	{
		name: "FsStatRequest",
		validate: isFsStatRequest,
		doc: { path: "a.txt" } satisfies FsStatRequest,
	},
	{
		name: "FsReaddirRequest",
		validate: isFsReaddirRequest,
		doc: { path: "." },
	},
	{
		name: "GrepRequest",
		validate: isGrepRequest,
		doc: {
			pattern: "foo",
			path: "src",
			glob: "*.ts",
			ignoreCase: true,
			literal: false,
			context: 2,
			limit: 100,
		} satisfies GrepRequest,
	},
	{
		name: "FindRequest",
		validate: isFindRequest,
		doc: { pattern: "*.test.ts", path: ".", limit: 50 } satisfies FindRequest,
	},
];

describe("protocol golden fixtures", () => {
	for (const { name, validate, doc } of fixtures) {
		it(`${name} survives JSON round-trip and validates`, () => {
			const wire = JSON.stringify(doc);
			const parsed: unknown = JSON.parse(wire);
			expect(validate(parsed)).toBe(true);
			expect(parsed).toEqual(doc);
		});
	}
});

describe("request validators reject malformed bodies", () => {
	it("rejects missing required fields", () => {
		expect(isBashExecRequest({ opId: "x", command: "ls" })).toBe(false);
		expect(isFsWriteRequest({ path: "a" })).toBe(false);
		expect(isGrepRequest({ path: "." })).toBe(false);
	});

	it("rejects wrong field types", () => {
		expect(isBashExecRequest({ opId: 1, command: "ls", cwd: "." })).toBe(false);
		expect(isFsAccessRequest({ path: "a", mode: "4" })).toBe(false);
		expect(isBashExecRequest({ opId: "x", command: "ls", cwd: ".", env: { A: 1 } })).toBe(false);
	});

	it("rejects non-objects", () => {
		expect(isFsReadRequest(null)).toBe(false);
		expect(isFsReadRequest("path")).toBe(false);
		expect(isFindRequest([1, 2])).toBe(false);
	});
});

describe("error format", () => {
	it("rpcError produces the spec shape and round-trips", () => {
		const err = rpcError("path_escape", "escapes root");
		expect(err).toEqual({ error: { code: "path_escape", message: "escapes root" } });
		expect(isRpcError(JSON.parse(JSON.stringify(err)))).toBe(true);
	});

	it("maps codes to HTTP status per spec", () => {
		expect(RPC_ERROR_HTTP_STATUS).toEqual({
			bad_request: 400,
			unauthorized: 401,
			not_found: 404,
			path_escape: 403,
			conflict: 409,
			payload_too_large: 413,
			internal: 500,
		});
	});

	it("rejects unknown codes", () => {
		expect(isRpcError({ error: { code: "weird", message: "x" } })).toBe(false);
	});
});

describe("endpoint paths", () => {
	it("all endpoints are /v1-prefixed", () => {
		for (const path of Object.values(SANDBOX_ENDPOINTS)) {
			expect(path.startsWith("/v1/")).toBe(true);
		}
	});
});
