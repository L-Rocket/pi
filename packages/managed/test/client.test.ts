import { describe, expect, it } from "vitest";
import { SandboxClient, SandboxRpcError } from "../src/client/sandbox-client.ts";

const noSleep = async () => {};

function connectFailure(): Error {
	return Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function clientWith(fetchImpl: typeof fetch): SandboxClient {
	return new SandboxClient({ baseUrl: "http://sandbox.test/", fetchImpl, sleep: noSleep });
}

describe("SandboxClient", () => {
	it("strips a trailing slash from the base URL and sends auth", async () => {
		let seenUrl = "";
		let seenAuth: string | null = null;
		const fetchImpl = (async (input: unknown, init?: RequestInit) => {
			seenUrl = String(input);
			seenAuth = new Headers(init?.headers).get("authorization");
			return jsonResponse(200, { ok: true });
		}) as typeof fetch;
		const client = new SandboxClient({ baseUrl: "http://sandbox.test/", token: "t", fetchImpl, sleep: noSleep });
		await client.call("/v1/thing", {});
		expect(seenUrl).toBe("http://sandbox.test/v1/thing");
		expect(seenAuth).toBe("Bearer t");
	});

	it("retries connect failures within the cold-start budget", async () => {
		let attempts = 0;
		const fetchImpl = (async () => {
			attempts++;
			if (attempts < 3) throw connectFailure();
			return jsonResponse(200, { done: true });
		}) as typeof fetch;
		const result = await clientWith(fetchImpl).call<{ done: boolean }>("/v1/x", {});
		expect(result.done).toBe(true);
		expect(attempts).toBe(3);
	});

	it("retries 503 responses as cold-start signals", async () => {
		let attempts = 0;
		const fetchImpl = (async () => {
			attempts++;
			return attempts === 1 ? jsonResponse(503, {}) : jsonResponse(200, { done: true });
		}) as typeof fetch;
		const result = await clientWith(fetchImpl).call<{ done: boolean }>("/v1/x", {});
		expect(result.done).toBe(true);
		expect(attempts).toBe(2);
	});

	it("gives up on connect failures once the budget is exhausted", async () => {
		const fetchImpl = (async () => {
			throw connectFailure();
		}) as typeof fetch;
		const client = new SandboxClient({
			baseUrl: "http://sandbox.test",
			fetchImpl,
			sleep: noSleep,
			coldStartBudgetMs: 0,
		});
		await expect(client.call("/v1/x", {})).rejects.toThrow("fetch failed");
	});

	it("retries a 5xx once for idempotent calls only", async () => {
		let attempts = 0;
		const fetchImpl = (async () => {
			attempts++;
			return attempts === 1
				? jsonResponse(500, { error: { code: "internal", message: "boom" } })
				: jsonResponse(200, 1);
		}) as typeof fetch;
		const result = await clientWith(fetchImpl).call<number>("/v1/x", {}, { idempotent: true });
		expect(result).toBe(1);
		expect(attempts).toBe(2);
	});

	it("does not retry 5xx for non-idempotent calls", async () => {
		let attempts = 0;
		const fetchImpl = (async () => {
			attempts++;
			return jsonResponse(500, { error: { code: "internal", message: "boom" } });
		}) as typeof fetch;
		await expect(clientWith(fetchImpl).call("/v1/x", {})).rejects.toMatchObject({ code: "internal", status: 500 });
		expect(attempts).toBe(1);
	});

	it("maps RPC error bodies to SandboxRpcError with code and status", async () => {
		const fetchImpl = (async () =>
			jsonResponse(404, { error: { code: "not_found", message: "missing" } })) as typeof fetch;
		const error = await clientWith(fetchImpl)
			.call("/v1/x", {})
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(SandboxRpcError);
		expect((error as SandboxRpcError).code).toBe("not_found");
		expect((error as SandboxRpcError).status).toBe(404);
		expect((error as SandboxRpcError).message).toBe("missing");
	});

	it("wraps non-RPC error bodies as internal errors", async () => {
		const fetchImpl = (async () => new Response("gateway exploded", { status: 502 })) as typeof fetch;
		await expect(clientWith(fetchImpl).call("/v1/x", {})).rejects.toMatchObject({
			code: "internal",
			status: 502,
		});
	});
});
