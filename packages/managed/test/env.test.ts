import { afterAll, describe, expect, it } from "vitest";
import { ENV_WHITELIST, scrubbedEnv } from "../src/sandbox/env.ts";

describe("scrubbedEnv", () => {
	it("keeps only whitelisted variables from the worker env", () => {
		process.env.MANAGED_TEST_SECRET = "should-not-leak";
		try {
			const env = scrubbedEnv();
			expect(env.MANAGED_TEST_SECRET).toBeUndefined();
			for (const key of Object.keys(env)) {
				expect(ENV_WHITELIST).toContain(key);
			}
		} finally {
			delete process.env.MANAGED_TEST_SECRET;
		}
	});

	it("merges request env over the whitelist base", () => {
		const env = scrubbedEnv({ FOO: "bar", PATH: "/custom/path" });
		expect(env.FOO).toBe("bar");
		expect(env.PATH).toBe("/custom/path");
	});
});

afterAll(() => {
	delete process.env.MANAGED_TEST_SECRET;
});
