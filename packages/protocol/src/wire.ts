import { fail, ok, type ProtocolResult } from "./errors.js";
import { LIMITS, METHODS, PROTOCOL_VERSION, type Method } from "./limits.js";
import {
  isPlainObject,
  payloadByteLength,
  requireRequestId,
} from "./check.js";
import { validateMethodBody } from "./jobs.js";

export type WireValidateOptions = {
  nowMs: number;
  frameByteLength: number;
};

export type WireRequest = {
  protocolVersion: typeof PROTOCOL_VERSION;
  requestId: string;
  method: Method;
  body: unknown;
  expiresAt: number;
};

export function validateWireRequest(
  input: unknown,
  opts: WireValidateOptions,
): ProtocolResult<WireRequest> {
  if (typeof opts.frameByteLength !== "number" || !Number.isInteger(opts.frameByteLength) || opts.frameByteLength < 0) {
    return fail("malformed", "frameByteLength must be a non-negative integer");
  }
  if (opts.frameByteLength > LIMITS.maxFrameBytes) {
    return fail("frame_too_large", `frame exceeds ${LIMITS.maxFrameBytes} bytes`);
  }
  if (!isPlainObject(input)) return fail("malformed", "request must be a plain object");
  if (!("protocolVersion" in input)) return fail("malformed", "protocolVersion is required");
  if (typeof input.protocolVersion !== "number" || !Number.isInteger(input.protocolVersion)) {
    return fail("malformed", "protocolVersion must be an integer");
  }
  if (input.protocolVersion !== PROTOCOL_VERSION) {
    return fail(
      "unsupported_protocol_version",
      `protocolVersion ${input.protocolVersion} is not supported (expected ${PROTOCOL_VERSION})`,
    );
  }

  const requestId = requireRequestId(input.requestId);
  if (!requestId.ok) return requestId;

  if (typeof input.method !== "string" || input.method.length === 0 || input.method.length > LIMITS.maxMethodChars) {
    return fail("unknown_method", "method must be a known non-empty string");
  }
  if (!METHODS.includes(input.method as Method)) {
    return fail("unknown_method", `unknown method ${input.method}`);
  }

  if (!isPlainObject(input.body)) return fail("invalid_body", "body must be a plain object");
  let payloadBytes: number;
  try {
    payloadBytes = payloadByteLength(input.body);
  } catch {
    return fail("invalid_body", "body is not JSON-serializable");
  }
  if (payloadBytes > LIMITS.maxPayloadBytes) {
    return fail("payload_too_large", `body exceeds ${LIMITS.maxPayloadBytes} UTF-8 bytes`);
  }

  if (typeof input.expiresAt !== "number" || !Number.isInteger(input.expiresAt)) {
    return fail("expired", "expiresAt must be an integer unix millisecond timestamp");
  }
  if (input.expiresAt <= opts.nowMs || input.expiresAt > opts.nowMs + LIMITS.maxRequestTtlMs) {
    return fail(
      "expired",
      `expiresAt must be > now and <= now + ${LIMITS.maxRequestTtlMs}ms`,
    );
  }

  const body = validateMethodBody(input.method, input.body, { nowMs: opts.nowMs });
  if (!body.ok) return body;

  return ok({
    protocolVersion: PROTOCOL_VERSION,
    requestId: requestId.value,
    method: input.method as Method,
    body: body.value,
    expiresAt: input.expiresAt,
  });
}
