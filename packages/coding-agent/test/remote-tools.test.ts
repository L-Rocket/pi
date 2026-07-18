import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSandboxServer } from "@earendil-works/pi-managed";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createAllToolDefinitions } from "../src/core/tools/index.ts";
import { createSandboxToolsOptions } from "../src/core/tools/remote.ts";

// End-to-end wiring: tools built with sandbox options execute against a real
// Sandbox Worker while the runtime cwd and sandbox root are the same tmpdir.
let root: string;
let server: Server;
let baseUrl: string;

function textOf(result: { content: { type: string; text?: string }[] }): string {
	return result.content
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("\n");
}

beforeAll(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "remote-tools-test-")));
	await mkdir(join(root, "src"), { recursive: true });
	await writeFile(join(root, "src", "hello.ts"), "export const hello = " + '"world";\n');
	await writeFile(join(root, "notes.txt"), "alpha\nbeta\ngamma\n");
	server = await createSandboxServer({ root });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
	await rm(root, { recursive: true, force: true });
});

describe("createSandboxToolsOptions", () => {
	it("returns undefined when PI_SANDBOX_URL is not set", () => {
		expect(createSandboxToolsOptions(root, {})).toBeUndefined();
	});

	it("returns per-tool operations when PI_SANDBOX_URL is set", () => {
		const options = createSandboxToolsOptions(root, { PI_SANDBOX_URL: baseUrl });
		expect(options?.bash?.operations).toBeDefined();
		expect(options?.bash?.persistFullOutput).toBeDefined();
		expect(options?.grep?.operations?.search).toBeDefined();
		expect(options?.read?.operations).toBeDefined();
		expect(options?.write?.operations).toBeDefined();
		expect(options?.edit?.operations).toBeDefined();
		expect(options?.find?.operations).toBeDefined();
		expect(options?.ls?.operations).toBeDefined();
	});
});

describe("tools over a remote sandbox", () => {
	it("runs bash, grep, read, write, and find against the worker", async () => {
		const options = createSandboxToolsOptions(root, { PI_SANDBOX_URL: baseUrl });
		const tools = createAllToolDefinitions(root, options);

		const bash = await tools.bash.execute(
			"call-bash",
			{ command: "echo remote-ok" },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(textOf(bash)).toContain("remote-ok");

		const grep = await tools.grep.execute(
			"call-grep",
			{ pattern: "hello", path: "src" },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(textOf(grep)).toContain("hello.ts:1:");

		const read = await tools.read.execute(
			"call-read",
			{ path: "notes.txt" },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(textOf(read)).toContain("beta");

		await tools.write.execute(
			"call-write",
			{ path: "created.txt", content: "made remotely\n" },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		const readBack = await tools.read.execute(
			"call-read-2",
			{ path: "created.txt" },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(textOf(readBack)).toContain("made remotely");

		const find = await tools.find.execute(
			"call-find",
			{ pattern: "*.ts", path: "." },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(textOf(find)).toContain("src/hello.ts");
	});

	it("relocates truncated bash output into the sandbox", async () => {
		const options = createSandboxToolsOptions(root, { PI_SANDBOX_URL: baseUrl });
		const tools = createAllToolDefinitions(root, options);

		const result = await tools.bash.execute(
			"call-overflow",
			{ command: "seq 1 3000" },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		const output = textOf(result);
		expect(output).toMatch(/Full output: /);
		const fullOutputPath = output.match(/Full output: ([^\]\n]+)/)?.[1]?.trim();
		expect(fullOutputPath).toBeDefined();
		expect(fullOutputPath!.startsWith(join(root, ".pi", "tool-output"))).toBe(true);

		const read = await tools.read.execute(
			"call-overflow-read",
			{ path: fullOutputPath!, offset: 2995 },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(textOf(read)).toContain("3000");
	});
});
