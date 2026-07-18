import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createJail, type Jail, JailError } from "../src/sandbox/jail.ts";

let root: string;
let outside: string;
let jail: Jail;

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "jail-root-"));
	outside = await mkdtemp(join(tmpdir(), "jail-outside-"));
	await mkdir(join(root, "sub"), { recursive: true });
	await writeFile(join(root, "sub", "file.txt"), "hello");
	await writeFile(join(outside, "secret.txt"), "secret");
	await symlink(outside, join(root, "escape-link"));
	jail = await createJail(root);
});

afterAll(async () => {
	const { rm } = await import("node:fs/promises");
	await rm(root, { recursive: true, force: true });
	await rm(outside, { recursive: true, force: true });
});

describe("resolveJailPath", () => {
	it("resolves the root itself", async () => {
		expect(await jail.resolve(".")).toBe(jail.root);
	});

	it("resolves relative paths inside root", async () => {
		expect(await jail.resolve("sub/file.txt")).toBe(join(jail.root, "sub", "file.txt"));
	});

	it("resolves absolute paths inside root", async () => {
		expect(await jail.resolve(join(jail.root, "sub", "file.txt"))).toBe(join(jail.root, "sub", "file.txt"));
	});

	it("allows non-existent paths inside root (for write)", async () => {
		expect(await jail.resolve("new/dir/file.txt")).toBe(join(jail.root, "new", "dir", "file.txt"));
	});

	it("rejects .. escape", async () => {
		await expect(jail.resolve("../outside")).rejects.toThrow(JailError);
		await expect(jail.resolve("sub/../../outside")).rejects.toThrow(JailError);
	});

	it("rejects absolute path outside root", async () => {
		await expect(jail.resolve(join(outside, "secret.txt"))).rejects.toThrow(JailError);
		await expect(jail.resolve("/etc/passwd")).rejects.toThrow(JailError);
	});

	it("rejects symlink escape on existing file", async () => {
		await expect(jail.resolve("escape-link/secret.txt")).rejects.toThrow(JailError);
	});

	it("rejects symlink escape on non-existent leaf under symlinked dir", async () => {
		await expect(jail.resolve("escape-link/new-file.txt")).rejects.toThrow(JailError);
	});
});
