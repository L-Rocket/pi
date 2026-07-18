import { type ChildProcess, spawn } from "node:child_process";
import type { BashExecRequest, BashExecResponse } from "../protocol/sandbox.ts";
import { scrubbedEnv } from "./env.ts";
import { getShellConfig, killProcessTree } from "./shell.ts";

export const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

export class OpConflictError extends Error {
	readonly opId: string;

	constructor(opId: string) {
		super(`Operation already running: ${opId}`);
		this.name = "OpConflictError";
		this.opId = opId;
	}
}

class CappedCollector {
	private chunks: Buffer[] = [];
	private bytes = 0;
	truncated = false;

	append(chunk: Buffer): void {
		if (this.bytes >= MAX_OUTPUT_BYTES) {
			this.truncated = true;
			return;
		}
		if (this.bytes + chunk.length > MAX_OUTPUT_BYTES) {
			this.chunks.push(chunk.subarray(0, MAX_OUTPUT_BYTES - this.bytes));
			this.bytes = MAX_OUTPUT_BYTES;
			this.truncated = true;
			return;
		}
		this.chunks.push(chunk);
		this.bytes += chunk.length;
	}

	toBase64(): string {
		return Buffer.concat(this.chunks).toString("base64");
	}
}

export class ExecRegistry {
	private running = new Map<string, ChildProcess>();

	async exec(request: BashExecRequest, cwd: string): Promise<BashExecResponse> {
		if (this.running.has(request.opId)) {
			throw new OpConflictError(request.opId);
		}
		const shellConfig = getShellConfig();
		const commandFromStdin = shellConfig.commandTransport === "stdin";
		const child = spawn(
			shellConfig.shell,
			commandFromStdin ? shellConfig.args : [...shellConfig.args, request.command],
			{
				cwd,
				env: scrubbedEnv(request.env),
				detached: process.platform !== "win32",
				stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
				windowsHide: true,
			},
		);
		if (commandFromStdin) {
			child.stdin?.on("error", () => {});
			child.stdin?.end(request.command);
		}
		this.running.set(request.opId, child);
		try {
			return await this.waitForExit(child, request.timeout);
		} finally {
			this.running.delete(request.opId);
		}
	}

	cancel(opId: string): boolean {
		const child = this.running.get(opId);
		if (!child || child.pid === undefined) return false;
		killProcessTree(child.pid);
		return true;
	}

	private waitForExit(child: ChildProcess, timeoutSeconds?: number): Promise<BashExecResponse> {
		return new Promise((resolve, reject) => {
			const stdout = new CappedCollector();
			const stderr = new CappedCollector();
			let timedOut = false;
			let timeoutHandle: NodeJS.Timeout | undefined;

			child.stdout?.on("data", (chunk: Buffer) => stdout.append(chunk));
			child.stderr?.on("data", (chunk: Buffer) => stderr.append(chunk));
			child.on("error", reject);

			if (timeoutSeconds !== undefined) {
				timeoutHandle = setTimeout(() => {
					timedOut = true;
					if (child.pid) killProcessTree(child.pid);
				}, timeoutSeconds * 1000);
			}

			child.on("close", (code) => {
				if (timeoutHandle) clearTimeout(timeoutHandle);
				resolve({
					stdout: stdout.toBase64(),
					stderr: stderr.toBase64(),
					exitCode: code,
					timedOut,
					...(stdout.truncated ? { stdoutTruncated: true } : {}),
					...(stderr.truncated ? { stderrTruncated: true } : {}),
				});
			});
		});
	}
}
