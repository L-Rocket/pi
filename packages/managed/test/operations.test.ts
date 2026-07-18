import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRemoteToolOperations, type RemoteToolOperations } from "../src/client/operations.ts";
import { SandboxClient } from "../src/client/sandbox-client.ts";
import { createSandboxServer } from "../src/sandbox/server.ts";

// The runtime cwd and sandbox root are the same tmpdir, mirroring M1 local dev.
let root: string;
let server: Server;
let ops: RemoteToolOperations;

const PNG_1X1 = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
	"base64",
);

beforeAll(async () => {
	// The jail canonicalizes the root via realpath; do the same so path comparisons line up.
	root = await realpath(await mkdtemp(join(tmpdir(), "remote-ops-test-")));
	await mkdir(join(root, "src", "nested"), { recursive: true });
	await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
	await writeFile(join(root, "src", "a.ts"), "const foo = 1;\nconst bar = 2;\nconst baz = 3;\n");
	await writeFile(join(root, "src", "nested", "b.ts"), "foo again\n");
	await writeFile(join(root, "node_modules", "pkg", "index.js"), "foo in node_modules\n");
	await writeFile(join(root, "README.md"), "# hello\nfoo line\n");
	await writeFile(join(root, "pixel.png"), PNG_1X1);
	server = await createSandboxServer({ root });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as AddressInfo;
	const client = new SandboxClient({ baseUrl: `http://127.0.0.1:${address.port}` });
	ops = createRemoteToolOperations(client, { cwd: root });
});

afterAll(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
	await rm(root, { recursive: true, force: true });
});

describe("bash operations", () => {
	it("delivers stdout and stderr via onData and returns the exit code", async () => {
		const chunks: string[] = [];
		const result = await ops.bash.exec("echo out; echo err >&2; exit 3", root, {
			onData: (data) => chunks.push(data.toString("utf-8")),
		});
		expect(result.exitCode).toBe(3);
		expect(chunks.join("")).toContain("out\n");
		expect(chunks.join("")).toContain("err\n");
	});

	it("runs in the requested cwd relative to the sandbox root", async () => {
		const chunks: string[] = [];
		await ops.bash.exec("pwd", join(root, "src"), { onData: (d) => chunks.push(d.toString("utf-8")) });
		expect(chunks.join("").trim()).toBe(join(root, "src"));
	});

	it("throws timeout:<n> when the worker reports a timeout", async () => {
		await expect(ops.bash.exec("sleep 5", root, { onData: () => {}, timeout: 1 })).rejects.toThrow("timeout:1");
	});

	it("aborts via signal with Error('aborted') and kills the process", async () => {
		const controller = new AbortController();
		const promise = ops.bash.exec("sleep 30", root, { onData: () => {}, signal: controller.signal });
		setTimeout(() => controller.abort(), 100);
		await expect(promise).rejects.toThrow("aborted");
	});

	it("does not forward runtime env to the sandbox", async () => {
		const chunks: string[] = [];
		await ops.bash.exec('echo "SECRET=[$SECRET_TOKEN]"', root, {
			onData: (d) => chunks.push(d.toString("utf-8")),
			env: { SECRET_TOKEN: "leak-me-not" },
		});
		const output = chunks.join("");
		expect(output).toContain("SECRET=[]");
		expect(output).not.toContain("leak-me-not");
	});
});

describe("read operations", () => {
	it("reads file contents as a Buffer", async () => {
		const content = await ops.read.readFile(join(root, "README.md"));
		expect(content.toString("utf-8")).toBe("# hello\nfoo line\n");
	});

	it("read of a missing file throws an ENOENT-coded error", async () => {
		await expect(ops.read.readFile(join(root, "nope.txt"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("access resolves for readable files and throws for missing ones", async () => {
		await expect(ops.read.access(join(root, "README.md"))).resolves.toBeUndefined();
		await expect(ops.read.access(join(root, "nope.txt"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("detects image mime types and returns null for text", async () => {
		expect(await ops.read.detectImageMimeType(join(root, "pixel.png"))).toBe("image/png");
		expect(await ops.read.detectImageMimeType(join(root, "README.md"))).toBeNull();
	});
});

describe("write operations", () => {
	it("mkdir and writeFile create files readable back", async () => {
		await ops.write.mkdir(join(root, "out", "deep"));
		await ops.write.writeFile(join(root, "out", "deep", "f.txt"), "hello");
		const content = await ops.read.readFile(join(root, "out", "deep", "f.txt"));
		expect(content.toString("utf-8")).toBe("hello");
	});
});

describe("edit operations", () => {
	it("readFile/writeFile/access round-trip", async () => {
		await ops.edit.writeFile(join(root, "edit.txt"), "v1");
		expect((await ops.edit.readFile(join(root, "edit.txt"))).toString("utf-8")).toBe("v1");
		await expect(ops.edit.access(join(root, "edit.txt"))).resolves.toBeUndefined();
		await expect(ops.edit.access(join(root, "missing.txt"))).rejects.toMatchObject({ code: "ENOENT" });
	});
});

describe("ls operations", () => {
	it("exists, stat, and readdir behave like the local fs", async () => {
		expect(await ops.ls.exists(join(root, "src"))).toBe(true);
		expect(await ops.ls.exists(join(root, "nope"))).toBe(false);
		expect((await ops.ls.stat(join(root, "src"))).isDirectory()).toBe(true);
		expect((await ops.ls.stat(join(root, "README.md"))).isDirectory()).toBe(false);
		const entries = await ops.ls.readdir(join(root, "src"));
		expect(entries.sort()).toEqual(["a.ts", "nested"]);
	});
});

describe("grep operations", () => {
	it("isDirectory and readFile mirror the local contract", async () => {
		expect(await ops.grep.isDirectory(join(root, "src"))).toBe(true);
		expect(await ops.grep.isDirectory(join(root, "README.md"))).toBe(false);
		expect(await ops.grep.readFile(join(root, "README.md"))).toBe("# hello\nfoo line\n");
	});

	it("search returns matches re-anchored under the runtime path", async () => {
		const result = await ops.grep.search({ pattern: "foo", path: join(root, "src"), limit: 10 });
		expect(result.limitReached).toBe(false);
		expect(result.matches).toHaveLength(2);
		const aMatch = result.matches.find((m) => m.filePath === join(root, "src", "a.ts"));
		expect(aMatch).toMatchObject({ lineNumber: 1, lineText: "const foo = 1;" });
		const bMatch = result.matches.find((m) => m.filePath === join(root, "src", "nested", "b.ts"));
		expect(bMatch).toMatchObject({ lineNumber: 1, lineText: "foo again" });
	});

	it("search honors glob, ignoreCase, literal, and limit", async () => {
		const globbed = await ops.grep.search({ pattern: "foo", path: root, glob: "*.md", limit: 10 });
		expect(globbed.matches.map((m) => m.filePath)).toEqual([join(root, "README.md")]);

		const cased = await ops.grep.search({ pattern: "FOO", path: join(root, "src"), ignoreCase: true, limit: 10 });
		expect(cased.matches.length).toBe(2);

		const limited = await ops.grep.search({ pattern: "foo", path: root, limit: 1 });
		expect(limited.matches).toHaveLength(1);
		expect(limited.limitReached).toBe(true);
	});
});

describe("find operations", () => {
	it("glob returns absolute runtime paths and honors ignore patterns", async () => {
		const paths = await ops.find.glob("*.ts", root, { ignore: ["**/node_modules/**", "**/.git/**"], limit: 100 });
		expect(paths.sort()).toEqual([join(root, "src", "a.ts"), join(root, "src", "nested", "b.ts")]);
	});

	it("glob honors the limit", async () => {
		const paths = await ops.find.glob("*.ts", root, { ignore: [], limit: 1 });
		expect(paths).toHaveLength(1);
	});

	it("exists mirrors fs access", async () => {
		expect(await ops.find.exists(join(root, "src"))).toBe(true);
		expect(await ops.find.exists(join(root, "nope"))).toBe(false);
	});
});
