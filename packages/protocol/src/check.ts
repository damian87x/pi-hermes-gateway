import { fail, ok, type ProtocolResult } from "./errors.js";
import {
  LIMITS,
  REQUEST_ID_PATTERN,
  ROUTE_FIELD_PATTERN,
} from "./limits.js";

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

export function payloadByteLength(body: unknown): number {
  return utf8ByteLength(JSON.stringify(body));
}

export function requirePlainObject(value: unknown, message = "value must be a plain object"): ProtocolResult<Record<string, unknown>> {
  if (!isPlainObject(value)) return fail("malformed", message);
  return ok(value);
}

export function requireString(value: unknown, code: string, message: string): ProtocolResult<string> {
  if (typeof value !== "string") return fail(code, message);
  return ok(value);
}

export function requireInteger(value: unknown, code: string, message: string): ProtocolResult<number> {
  if (typeof value !== "number" || !Number.isInteger(value)) return fail(code, message);
  return ok(value);
}

export function requireRequestId(value: unknown): ProtocolResult<string> {
  if (typeof value !== "string" || !REQUEST_ID_PATTERN.test(value)) {
    return fail("invalid_request_id", `requestId must match ${REQUEST_ID_PATTERN} (max ${LIMITS.maxRequestIdChars})`);
  }
  return ok(value);
}

export function requireToken(value: unknown, field: string, code: string): ProtocolResult<string> {
  if (typeof value !== "string" || value.length === 0 || value.length > LIMITS.maxRouteFieldChars || !ROUTE_FIELD_PATTERN.test(value)) {
    return fail(code, `${field} must be 1..${LIMITS.maxRouteFieldChars} chars matching ${ROUTE_FIELD_PATTERN}`);
  }
  return ok(value);
}

export function isIanaTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
    return true;
  } catch {
    return false;
  }
}
