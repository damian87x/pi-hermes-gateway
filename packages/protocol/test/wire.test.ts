import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LIMITS,
  validateWireRequest,
} from "../dist/index.js";
import { NOW, frameFor, utf8Bytes } from "./helpers.ts";

function validRequest(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: 1,
    requestId: "req-1",
    method: "delivery.inspect",
    body: { deliveryId: "del-1" },
    expiresAt: NOW + 5_000,
    ...overrides,
  };
}

test("accepts a supported wire request within limits", () => {
  const input = validRequest();
  const result = validateWireRequest(input, { nowMs: NOW, frameByteLength: frameFor(input) });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.method, "delivery.inspect");
    assert.equal(result.value.requestId, "req-1");
  }
});

test("rejects unsupported protocol versions", () => {
  const input = validRequest({ protocolVersion: 2 });
  const result = validateWireRequest(input, { nowMs: NOW, frameByteLength: frameFor(input) });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "unsupported_protocol_version");
});

test("rejects missing protocolVersion", () => {
  const { protocolVersion: _, ...rest } = validRequest();
  const result = validateWireRequest(rest, { nowMs: NOW, frameByteLength: frameFor(rest) });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "malformed");
});

test("rejects invalid request IDs", () => {
  for (const requestId of ["", "bad id", "x".repeat(LIMITS.maxRequestIdChars + 1), "id\n1"]) {
    const input = validRequest({ requestId });
    const result = validateWireRequest(input, { nowMs: NOW, frameByteLength: frameFor(input) });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "invalid_request_id");
  }
});

test("rejects unknown methods", () => {
  const input = validRequest({ method: "route.create" });
  const result = validateWireRequest(input, { nowMs: NOW, frameByteLength: frameFor(input) });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "unknown_method");
});

test("rejects non-object bodies", () => {
  const input = validRequest({ body: "not-json-object" });
  const result = validateWireRequest(input, { nowMs: NOW, frameByteLength: frameFor(input) });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "invalid_body");
});

test("rejects expired requests", () => {
  const input = validRequest({ expiresAt: NOW });
  const result = validateWireRequest(input, { nowMs: NOW, frameByteLength: frameFor(input) });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "expired");
});

test("rejects expiry beyond the bounded TTL", () => {
  const input = validRequest({ expiresAt: NOW + LIMITS.maxRequestTtlMs + 1 });
  const result = validateWireRequest(input, { nowMs: NOW, frameByteLength: frameFor(input) });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "expired");
});

test("rejects oversized frames", () => {
  const input = validRequest();
  const result = validateWireRequest(input, {
    nowMs: NOW,
    frameByteLength: LIMITS.maxFrameBytes + 1,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "frame_too_large");
});

test("rejects oversized payloads", () => {
  const body = { deliveryId: "d".repeat(LIMITS.maxPayloadBytes) };
  const input = validRequest({ body });
  const result = validateWireRequest(input, { nowMs: NOW, frameByteLength: LIMITS.maxFrameBytes });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "payload_too_large");
  assert.ok(utf8Bytes(body) > LIMITS.maxPayloadBytes);
});
