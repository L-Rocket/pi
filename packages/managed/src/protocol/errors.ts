export const RPC_ERROR_CODES = [
	"bad_request",
	"unauthorized",
	"not_found",
	"path_escape",
	"conflict",
	"payload_too_large",
	"internal",
] as const;

export type RpcErrorCode = (typeof RPC_ERROR_CODES)[number];

export interface RpcError {
	error: { code: RpcErrorCode; message: string };
}

export const RPC_ERROR_HTTP_STATUS: Record<RpcErrorCode, number> = {
	bad_request: 400,
	unauthorized: 401,
	not_found: 404,
	path_escape: 403,
	conflict: 409,
	payload_too_large: 413,
	internal: 500,
};

export function rpcError(code: RpcErrorCode, message: string): RpcError {
	return { error: { code, message } };
}

export function isRpcError(value: unknown): value is RpcError {
	if (typeof value !== "object" || value === null) return false;
	const err = (value as RpcError).error;
	return (
		typeof err === "object" &&
		err !== null &&
		typeof err.message === "string" &&
		typeof err.code === "string" &&
		(RPC_ERROR_CODES as readonly string[]).includes(err.code)
	);
}
