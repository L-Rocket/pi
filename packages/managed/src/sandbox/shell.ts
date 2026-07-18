// Minimal shell resolution and process-tree kill, mirroring the semantics of
// packages/coding-agent/src/utils/shell.ts. Kept as a local copy so @earendil-works/pi-managed
// stays dependency-free (no reverse dependency on coding-agent).

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

export interface ShellConfig {
	shell: string;
	args: string[];
	commandTransport?: "argv" | "stdin";
}

function isLegacyWslBashPath(path: string): boolean {
	const normalized = path.replace(/\//g, "\\").toLowerCase();
	return /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/.test(normalized);
}

function getBashShellConfig(shell: string): ShellConfig {
	return isLegacyWslBashPath(shell) ? { shell, args: ["-s"], commandTransport: "stdin" } : { shell, args: ["-c"] };
}

function findBashOnPath(): string | null {
	if (process.platform === "win32") {
		try {
			const result = spawnSync("where", ["bash.exe"], { encoding: "utf-8", timeout: 5000, windowsHide: true });
			if (result.status === 0 && result.stdout) {
				const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
				if (firstMatch && existsSync(firstMatch)) return firstMatch;
			}
		} catch {
			// ignore
		}
		return null;
	}
	try {
		const result = spawnSync("which", ["bash"], { encoding: "utf-8", timeout: 5000 });
		if (result.status === 0 && result.stdout) {
			const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
			if (firstMatch) return firstMatch;
		}
	} catch {
		// ignore
	}
	return null;
}

export function getShellConfig(): ShellConfig {
	if (process.platform === "win32") {
		const paths: string[] = [];
		const programFiles = process.env.ProgramFiles;
		if (programFiles) paths.push(`${programFiles}\\Git\\bin\\bash.exe`);
		const programFilesX86 = process.env["ProgramFiles(x86)"];
		if (programFilesX86) paths.push(`${programFilesX86}\\Git\\bin\\bash.exe`);
		for (const path of paths) {
			if (existsSync(path)) return getBashShellConfig(path);
		}
		const bashOnPath = findBashOnPath();
		if (bashOnPath) return getBashShellConfig(bashOnPath);
		throw new Error("No bash shell found");
	}
	if (existsSync("/bin/bash")) return getBashShellConfig("/bin/bash");
	const bashOnPath = findBashOnPath();
	if (bashOnPath) return getBashShellConfig(bashOnPath);
	return { shell: "sh", args: ["-c"] };
}

export function killProcessTree(pid: number): void {
	if (process.platform === "win32") {
		try {
			spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", detached: true, windowsHide: true });
		} catch {
			// ignore
		}
		return;
	}
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// already dead
		}
	}
}
