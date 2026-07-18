import { execSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RpcError } from "../src/protocol/errors.ts";
import type {
	BashExecResponse,
	FindResponse,
	FsAccessResponse,
	FsReaddirResponse,
	FsReadResponse,
	FsStatResponse,
	GrepResponse,
} from "../src/protocol/sandbox.ts";
import { SANDBOX_ENDPOINTS } from "../src/protocol/sandbox.ts";
import { createSandboxServer } from "../src/sandbox/server.ts";

let root: string;
let server: Server;
let baseUrl: string;

async function post<T>(path: string, body: unknown): Promise<{ status: number; json: T }> {
	const res = await fetch(`${baseUrl}${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	return { status: res.status, json: (await res.json()) as T };
}

function b64(text: string): string {
	return Buffer.from(text, "utf-8").toString("base64");
}

function unb64(content: string): string {
	return Buffer.from(content, "base64").toString("utf-8");
}

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "sandbox-test-"));
	await mkdir(join(root, "src", "nested"), { recursive: true });
	await writeFile(join(root, "src", "a.ts"), "const foo = 1;\nconst bar = 2;\nconst baz = 3;\n");
	await writeFile(join(root, "src", "nested", "b.ts"), "foo again\n");
	await writeFile(join(root, "README.md"), "# hello\nfoo line\n");
	server = await createSandboxServer({ root });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as AddressInfo;
	baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
	await rm(root, { recursive: true, force: true });
});

describe("healthz", () => {
	it("returns ok", async () => {
		const res = await fetch(`${baseUrl}${SANDBOX_ENDPOINTS.healthz}`);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
	});
});

describe("fs endpoints", () => {
	it("write then read round-trips base64 content", async () => {
		const write = await post<object>(SANDBOX_ENDPOINTS.fsWrite, { path: "out.bin", content: b64("binary\x00data") });
		expect(write.status).toBe(200);
		const read = await post<FsReadResponse>(SANDBOX_ENDPOINTS.fsRead, { path: "out.bin" });
		expect(read.status).toBe(200);
		expect(unb64(read.json.content)).toBe("binary\x00data");
	});

	it("read of missing file is 404 not_found", async () => {
		const res = await post<RpcError>(SANDBOX_ENDPOINTS.fsRead, { path: "nope.txt" });
		expect(res.status).toBe(404);
		expect(res.json.error.code).toBe("not_found");
	});

	it("write with missing parent is 404", async () => {
		const res = await post<RpcError>(SANDBOX_ENDPOINTS.fsWrite, {
			path: "missing-dir/file.txt",
			content: b64("x"),
		});
		expect(res.status).toBe(404);
		expect(res.json.error.code).toBe("not_found");
	});

	it("mkdir recursive and readdir", async () => {
		const mk = await post<object>(SANDBOX_ENDPOINTS.fsMkdir, { path: "new/deep/dir" });
		expect(mk.status).toBe(200);
		const list = await post<FsReaddirResponse>(SANDBOX_ENDPOINTS.fsReaddir, { path: "new/deep" });
		expect(list.json.entries).toContainEqual({ name: "dir", isDirectory: true });
	});

	it("access reports existence without erroring", async () => {
		const exists = await post<FsAccessResponse>(SANDBOX_ENDPOINTS.fsAccess, { path: "src/a.ts" });
		expect(exists.json.ok).toBe(true);
		const missing = await post<FsAccessResponse>(SANDBOX_ENDPOINTS.fsAccess, { path: "nope" });
		expect(missing.status).toBe(200);
		expect(missing.json.ok).toBe(false);
	});

	it("stat returns file metadata", async () => {
		const res = await post<FsStatResponse>(SANDBOX_ENDPOINTS.fsStat, { path: "src/a.ts" });
		expect(res.json.isFile).toBe(true);
		expect(res.json.isDirectory).toBe(false);
		expect(res.json.size).toBeGreaterThan(0);
	});
});

describe("jail enforcement", () => {
	it("rejects .. escape with 403 path_escape", async () => {
		const res = await post<RpcError>(SANDBOX_ENDPOINTS.fsRead, { path: "../../etc/passwd" });
		expect(res.status).toBe(403);
		expect(res.json.error.code).toBe("path_escape");
	});

	it("rejects symlink escape", async () => {
		const outside = await mkdtemp(join(tmpdir(), "sandbox-outside-"));
		await writeFile(join(outside, "secret.txt"), "secret");
		await symlink(outside, join(root, "link-out"));
		const res = await post<RpcError>(SANDBOX_ENDPOINTS.fsRead, { path: "link-out/secret.txt" });
		expect(res.status).toBe(403);
		expect(res.json.error.code).toBe("path_escape");
		await rm(outside, { recursive: true, force: true });
	});

	it("rejects bash cwd escape", async () => {
		const res = await post<RpcError>(SANDBOX_ENDPOINTS.bashExec, {
			opId: "cwd-escape",
			command: "pwd",
			cwd: "../..",
		});
		expect(res.status).toBe(403);
		expect(res.json.error.code).toBe("path_escape");
	});
});

describe("bash exec", () => {
	it("captures stdout and exit code", async () => {
		const res = await post<BashExecResponse>(SANDBOX_ENDPOINTS.bashExec, {
			opId: "echo-1",
			command: "echo hello",
			cwd: ".",
		});
		expect(res.status).toBe(200);
		expect(unb64(res.json.stdout).trim()).toBe("hello");
		expect(res.json.exitCode).toBe(0);
		expect(res.json.timedOut).toBe(false);
	});

	it("captures non-zero exit code and stderr", async () => {
		const res = await post<BashExecResponse>(SANDBOX_ENDPOINTS.bashExec, {
			opId: "fail-1",
			command: "echo oops >&2; exit 3",
			cwd: ".",
		});
		expect(res.json.exitCode).toBe(3);
		expect(unb64(res.json.stderr).trim()).toBe("oops");
	});

	it("does not leak worker env into child processes", async () => {
		process.env.MANAGED_TEST_SECRET = "topsecret";
		try {
			const res = await post<BashExecResponse>(SANDBOX_ENDPOINTS.bashExec, {
				opId: "env-1",
				command: "env",
				cwd: ".",
			});
			const env = unb64(res.json.stdout);
			expect(env).not.toContain("MANAGED_TEST_SECRET");
			expect(env).toContain("PATH=");
		} finally {
			delete process.env.MANAGED_TEST_SECRET;
		}
	});

	it("merges request env", async () => {
		const res = await post<BashExecResponse>(SANDBOX_ENDPOINTS.bashExec, {
			opId: "env-2",
			command: "echo $MANAGED_TEST_FOO",
			cwd: ".",
			env: { MANAGED_TEST_FOO: "bar" },
		});
		expect(unb64(res.json.stdout).trim()).toBe("bar");
	});

	it("rejects conflicting opId with 409", async () => {
		const first = fetch(`${baseUrl}${SANDBOX_ENDPOINTS.bashExec}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ opId: "dup", command: "sleep 2", cwd: "." }),
		});
		await new Promise((r) => setTimeout(r, 100));
		const second = await post<RpcError>(SANDBOX_ENDPOINTS.bashExec, { opId: "dup", command: "echo x", cwd: "." });
		expect(second.status).toBe(409);
		expect(second.json.error.code).toBe("conflict");
		await post<object>(SANDBOX_ENDPOINTS.bashCancel, { opId: "dup" });
		await first;
	});

	it("cancels a running command and kills the process tree", async () => {
		const execPromise = post<BashExecResponse>(SANDBOX_ENDPOINTS.bashExec, {
			opId: "cancel-me",
			command: "sleep 60 & echo $!; wait",
			cwd: ".",
		});
		await new Promise((r) => setTimeout(r, 300));
		const cancel = await post<{ cancelled: boolean }>(SANDBOX_ENDPOINTS.bashCancel, { opId: "cancel-me" });
		expect(cancel.json.cancelled).toBe(true);
		const exec = await execPromise;
		expect(exec.json.exitCode).toBeNull();
		const childPid = unb64(exec.json.stdout).trim();
		expect(() => execSync(`kill -0 ${childPid} 2>/dev/null`)).toThrow();
	});

	it("cancel of unknown opId returns false", async () => {
		const res = await post<{ cancelled: boolean }>(SANDBOX_ENDPOINTS.bashCancel, { opId: "nope" });
		expect(res.json.cancelled).toBe(false);
	});

	it("enforces timeout and kills the process tree", async () => {
		const res = await post<BashExecResponse>(SANDBOX_ENDPOINTS.bashExec, {
			opId: "timeout-1",
			command: "sleep 60 & echo $!; wait",
			cwd: ".",
			timeout: 1,
		});
		expect(res.json.timedOut).toBe(true);
		expect(res.json.exitCode).toBeNull();
		const childPid = unb64(res.json.stdout).trim();
		expect(() => execSync(`kill -0 ${childPid} 2>/dev/null`)).toThrow();
	});
});

describe("search endpoints", () => {
	it("grep returns matches with line numbers", async () => {
		const res = await post<GrepResponse>(SANDBOX_ENDPOINTS.grep, { pattern: "foo", path: "." });
		expect(res.status).toBe(200);
		const paths = res.json.matches.map((m) => m.path);
		expect(paths.some((p) => p.endsWith("a.ts"))).toBe(true);
		expect(paths.some((p) => p.endsWith("b.ts"))).toBe(true);
		expect(res.json.truncated).toBe(false);
		const match = res.json.matches.find((m) => m.path.endsWith("a.ts"));
		expect(match?.lineNumber).toBe(1);
	});

	it("grep attaches context lines", async () => {
		const res = await post<GrepResponse>(SANDBOX_ENDPOINTS.grep, { pattern: "bar", path: "src/a.ts", context: 1 });
		const match = res.json.matches[0];
		expect(match.lineNumber).toBe(2);
		expect(match.before).toEqual(["const foo = 1;"]);
		expect(match.after).toEqual(["const baz = 3;"]);
	});

	it("grep respects limit and sets truncated", async () => {
		const res = await post<GrepResponse>(SANDBOX_ENDPOINTS.grep, { pattern: "foo", path: ".", limit: 1 });
		expect(res.json.matches.length).toBe(1);
		expect(res.json.truncated).toBe(true);
	});

	it("grep respects glob", async () => {
		const res = await post<GrepResponse>(SANDBOX_ENDPOINTS.grep, { pattern: "foo", path: ".", glob: "*.md" });
		expect(res.json.matches.every((m) => m.path.endsWith(".md"))).toBe(true);
	});

	it("find returns matching paths", async () => {
		const res = await post<FindResponse>(SANDBOX_ENDPOINTS.find, { pattern: "*.ts", path: "." });
		expect(res.status).toBe(200);
		expect(res.json.paths.some((p) => p.endsWith("a.ts"))).toBe(true);
		expect(res.json.paths.some((p) => p.endsWith("b.ts"))).toBe(true);
		expect(res.json.truncated).toBe(false);
	});

	it("find respects limit", async () => {
		const res = await post<FindResponse>(SANDBOX_ENDPOINTS.find, { pattern: "*.ts", path: ".", limit: 1 });
		expect(res.json.paths.length).toBe(1);
		expect(res.json.truncated).toBe(true);
	});
});

describe("request validation", () => {
	it("rejects invalid JSON with 400", async () => {
		const res = await fetch(`${baseUrl}${SANDBOX_ENDPOINTS.fsRead}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{not json",
		});
		expect(res.status).toBe(400);
	});

	it("rejects missing fields with 400", async () => {
		const res = await post<RpcError>(SANDBOX_ENDPOINTS.bashExec, { opId: "x" });
		expect(res.status).toBe(400);
		expect(res.json.error.code).toBe("bad_request");
	});

	it("unknown route is 404", async () => {
		const res = await post<RpcError>("/v1/nope", {});
		expect(res.status).toBe(404);
	});
});
