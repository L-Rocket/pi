// Sandbox wiring: when PI_SANDBOX_URL is set, tool execution is delegated to a
// remote Sandbox Worker over RPC (docs/managed-agents-interface-spec.md §5).
// The sandbox is lazy: no handshake happens here, the first tool call triggers
// scale-from-zero and the client retries connect failures within its budget.

import {
	createRemoteToolOperations,
	createSandboxOverflowPersistence,
	SandboxClient,
} from "@earendil-works/pi-managed";
import type { ToolsOptions } from "./index.ts";

export const SANDBOX_URL_ENV = "PI_SANDBOX_URL";
export const MANAGED_TOKEN_ENV = "PI_MANAGED_TOKEN";

/**
 * Build ToolsOptions backed by the remote sandbox, or return undefined when
 * PI_SANDBOX_URL is not set (local execution stays the default).
 */
export function createSandboxToolsOptions(cwd: string, env: NodeJS.ProcessEnv = process.env): ToolsOptions | undefined {
	const baseUrl = env[SANDBOX_URL_ENV];
	if (!baseUrl) return undefined;
	const client = new SandboxClient({ baseUrl, token: env[MANAGED_TOKEN_ENV] });
	const remote = createRemoteToolOperations(client, { cwd });
	return {
		read: { operations: remote.read },
		bash: {
			operations: remote.bash,
			persistFullOutput: createSandboxOverflowPersistence(client, { cwd }),
		},
		write: { operations: remote.write },
		edit: { operations: remote.edit },
		grep: { operations: remote.grep },
		find: { operations: remote.find },
		ls: { operations: remote.ls },
	};
}
