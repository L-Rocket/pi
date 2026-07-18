import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { createInterface } from "node:readline";
import type { FindRequest, FindResponse, GrepMatch, GrepRequest, GrepResponse } from "../protocol/sandbox.ts";

// Result paths are returned relative to the search path so the client can
// re-anchor them under its own workspace root (roots may differ across machines).
function relativize(searchPath: string, filePath: string): string {
	const rel = relative(searchPath, filePath);
	return rel === "" ? "." : rel;
}

const DEFAULT_GREP_LIMIT = 250;
const DEFAULT_FIND_LIMIT = 1000;

interface RgMatchData {
	path: { text: string };
	lines: { text: string };
	line_number: number;
}

interface RgMessage {
	type: string;
	data?: RgMatchData;
}

export async function grepSearch(request: GrepRequest, searchPath: string): Promise<GrepResponse> {
	const limit = Math.max(1, request.limit ?? DEFAULT_GREP_LIMIT);
	const args: string[] = ["--json", "--line-number", "--color=never", "--hidden"];
	if (request.ignoreCase) args.push("--ignore-case");
	if (request.literal) args.push("--fixed-strings");
	if (request.glob) args.push("--glob", request.glob);
	args.push("--", request.pattern, searchPath);

	const rawMatches: { path: string; lineNumber: number; line: string }[] = [];
	let truncated = false;

	await new Promise<void>((resolvePromise, reject) => {
		const child = spawn("rg", args, { stdio: ["ignore", "pipe", "pipe"] });
		const rl = createInterface({ input: child.stdout });
		let stderr = "";

		rl.on("line", (line) => {
			if (rawMatches.length >= limit) {
				truncated = true;
				child.kill();
				return;
			}
			let message: RgMessage;
			try {
				message = JSON.parse(line) as RgMessage;
			} catch {
				return;
			}
			if (message.type !== "match" || !message.data) return;
			rawMatches.push({
				path: relativize(searchPath, message.data.path.text),
				lineNumber: message.data.line_number,
				line: message.data.lines.text.replace(/\r?\n$/, ""),
			});
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", (code) => {
			// rg exits 1 on no matches, and we kill it (non-zero) on limit.
			if (code !== 0 && rawMatches.length === 0 && stderr.trim()) {
				reject(new Error(`rg failed: ${stderr.trim()}`));
				return;
			}
			resolvePromise();
		});
	});

	const context = request.context && request.context > 0 ? Math.floor(request.context) : 0;
	const matches: GrepMatch[] = context === 0 ? rawMatches : await attachContext(rawMatches, context, searchPath);
	return { matches, truncated };
}

async function attachContext(rawMatches: GrepMatch[], context: number, searchPath: string): Promise<GrepMatch[]> {
	const fileCache = new Map<string, string[]>();
	const getLines = async (filePath: string): Promise<string[]> => {
		let lines = fileCache.get(filePath);
		if (!lines) {
			try {
				const content = await readFile(join(searchPath, filePath), "utf-8");
				lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
			} catch {
				lines = [];
			}
			fileCache.set(filePath, lines);
		}
		return lines;
	};

	const result: GrepMatch[] = [];
	for (const match of rawMatches) {
		const lines = await getLines(match.path);
		if (lines.length === 0) {
			result.push(match);
			continue;
		}
		const start = Math.max(1, match.lineNumber - context);
		const end = Math.min(lines.length, match.lineNumber + context);
		const before: string[] = [];
		const after: string[] = [];
		for (let i = start; i < match.lineNumber; i++) before.push(lines[i - 1] ?? "");
		for (let i = match.lineNumber + 1; i <= end; i++) after.push(lines[i - 1] ?? "");
		result.push({ ...match, before, after });
	}
	return result;
}

export async function findFiles(
	request: FindRequest,
	searchPath: string,
	insideGitRepo: boolean,
): Promise<FindResponse> {
	const limit = Math.max(1, request.limit ?? DEFAULT_FIND_LIMIT);
	const args: string[] = ["--glob", "--color=never", "--hidden"];
	if (!insideGitRepo) args.push("--no-require-git");
	for (const ignore of request.ignore ?? []) args.push("--exclude", ignore);
	args.push("--max-results", String(limit + 1));

	let effectivePattern = request.pattern;
	if (request.pattern.includes("/")) {
		args.push("--full-path");
		if (!request.pattern.startsWith("/") && !request.pattern.startsWith("**/") && request.pattern !== "**") {
			effectivePattern = `**/${request.pattern}`;
		}
	}
	args.push("--", effectivePattern, searchPath);

	const paths: string[] = [];
	let truncated = false;

	await new Promise<void>((resolvePromise, reject) => {
		const child = spawn("fd", args, { stdio: ["ignore", "pipe", "pipe"] });
		const rl = createInterface({ input: child.stdout });
		let stderr = "";

		rl.on("line", (line) => {
			if (paths.length >= limit) {
				truncated = true;
				child.kill();
				return;
			}
			paths.push(relativize(searchPath, line));
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (code !== 0 && paths.length === 0 && stderr.trim()) {
				reject(new Error(`fd failed: ${stderr.trim()}`));
				return;
			}
			resolvePromise();
		});
	});

	return { paths, truncated };
}
