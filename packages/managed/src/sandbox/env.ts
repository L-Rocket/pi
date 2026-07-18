// Child-process environment whitelist. The worker's own environment must never
// leak into executed commands: secrets (provider keys, tokens) may exist in the
// deploy environment, and the sandbox is the boundary that keeps them out of
// the execution environment.

export const ENV_WHITELIST = ["PATH", "HOME", "LANG", "LC_ALL", "TERM", "TMPDIR"] as const;

export function scrubbedEnv(requestEnv?: Record<string, string>): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const key of ENV_WHITELIST) {
		const value = process.env[key];
		if (value !== undefined) env[key] = value;
	}
	if (requestEnv) {
		Object.assign(env, requestEnv);
	}
	return env;
}
