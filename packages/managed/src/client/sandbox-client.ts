// HTTP client for the Sandbox Worker RPC protocol.
// Retry policy (docs/managed-agents-interface-spec.md §2):
// - Connect failures and 503s are retried within the cold-start budget (scale-from-zero).
// - Idempotent reads get one extra retry on failure after the request may have been sent.
// - Non-idempotent calls (writes, bash exec/cancel) are never retried once sent.

import { isRpcError, type RpcErrorCode } from "../protocol/errors.ts";

export class SandboxRpcError extends Error {
	code: RpcErrorCode;
	status: number;

	constructor(code: RpcErrorCode, message: string, status: number) {
		super(message);
		this.name = "SandboxRpcError";
		this.code = code;
		this.status = status;
	}
}

export interface SandboxClientOptions {
	baseUrl: string;
	token?: string;
	/** Budget in ms for retrying connect failures while the sandbox scales from zero. Default 60000. */
	coldStartBudgetMs?: number;
	fetchImpl?: typeof fetch;
	/** Test hook: override the sleep between retries. */
	sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_COLD_START_BUDGET_MS = 60_000;
const INITIAL_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 2_000;

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function connectFailureCode(error: unknown): string | undefined {
	if (!(error instanceof Error)) return undefined;
	const cause = (error as { cause?: unknown }).cause;
	if (cause && typeof cause === "object") {
		const code = (cause as NodeJS.ErrnoException).code;
		if (typeof code === "string") return code;
	}
	return (error as NodeJS.ErrnoException).code;
}

function isConnectFailure(error: unknown): boolean {
	if (error instanceof Error && error.name === "TypeError") return true;
	const code = connectFailureCode(error);
	return code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EPIPE" || code === "UND_ERR_SOCKET";
}

export class SandboxClient {
	private baseUrl: string;
	private token: string | undefined;
	private coldStartBudgetMs: number;
	private fetchImpl: typeof fetch;
	private sleep: (ms: number) => Promise<void>;

	constructor(options: SandboxClientOptions) {
		this.baseUrl = options.baseUrl.replace(/\/+$/, "");
		this.token = options.token;
		this.coldStartBudgetMs = options.coldStartBudgetMs ?? DEFAULT_COLD_START_BUDGET_MS;
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.sleep = options.sleep ?? defaultSleep;
	}

	async call<TRes>(path: string, body: unknown, opts?: { idempotent?: boolean }): Promise<TRes> {
		const idempotent = opts?.idempotent ?? false;
		const deadline = Date.now() + this.coldStartBudgetMs;
		let backoff = INITIAL_BACKOFF_MS;
		let sentAttempts = 0;

		for (;;) {
			let response: Response;
			try {
				response = await this.fetchImpl(`${this.baseUrl}${path}`, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
					},
					body: JSON.stringify(body),
				});
				sentAttempts++;
			} catch (error) {
				const withinBudget = Date.now() + backoff <= deadline;
				if (isConnectFailure(error) && withinBudget) {
					await this.sleep(backoff);
					backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
					continue;
				}
				if (idempotent && sentAttempts < 1) {
					sentAttempts++;
					await this.sleep(backoff);
					backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
					continue;
				}
				throw error;
			}

			if (response.status === 503 && Date.now() + backoff <= deadline) {
				await this.sleep(backoff);
				backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
				continue;
			}

			if (response.status >= 500 && idempotent && sentAttempts < 2) {
				await this.sleep(backoff);
				backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
				continue;
			}

			if (!response.ok) {
				const text = await response.text();
				let parsed: unknown;
				try {
					parsed = JSON.parse(text);
				} catch {
					parsed = undefined;
				}
				if (isRpcError(parsed)) {
					throw new SandboxRpcError(parsed.error.code, parsed.error.message, response.status);
				}
				throw new SandboxRpcError(
					"internal",
					`sandbox returned ${response.status}: ${text.slice(0, 200)}`,
					response.status,
				);
			}

			return (await response.json()) as TRes;
		}
	}
}
