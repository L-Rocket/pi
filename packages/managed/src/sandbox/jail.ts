import { realpath } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";

export class JailError extends Error {
	readonly input: string;

	constructor(input: string) {
		super(`Path escapes workspace root: ${input}`);
		this.name = "JailError";
		this.input = input;
	}
}

export interface Jail {
	readonly root: string;
	resolve(input: string): Promise<string>;
}

// Resolve symlinks on the nearest existing ancestor so that a non-existent
// leaf under a symlinked directory cannot escape (e.g. root/link -> /etc,
// write to link/newfile must be rejected).
async function realpathNearest(path: string): Promise<string> {
	let current = path;
	const tail: string[] = [];
	for (;;) {
		try {
			const real = await realpath(current);
			return tail.length === 0 ? real : join(real, ...tail.reverse());
		} catch {
			const parent = dirname(current);
			if (parent === current) return path;
			tail.push(basename(current));
			current = parent;
		}
	}
}

export async function createJail(root: string): Promise<Jail> {
	const canonicalRoot = await realpath(resolve(root));
	return {
		root: canonicalRoot,
		async resolve(input: string): Promise<string> {
			const resolved = resolve(canonicalRoot, input);
			const real = await realpathNearest(resolved);
			if (real !== canonicalRoot && !real.startsWith(canonicalRoot + sep)) {
				throw new JailError(input);
			}
			return real;
		},
	};
}
