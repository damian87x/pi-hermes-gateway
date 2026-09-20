import assert from "node:assert/strict";
import { test } from "node:test";
import { LIMITS, validateStaticDelivery } from "../dist/index.js";
import { NOW } from "./helpers.ts";

function validDelivery(overrides: Record<string, unknown> = {}) {
  return {
    route: {
      profileId: "profile-a",
      adapterId: "telegram",
      accountId: "bot-1",
      chatId: "123",
    },
    text: "hello",
    notAfter: NOW + 60_000,
    ...overrides,
  };
}

test("accepts a static owner-route text delivery", () => {
  const result = validateStaticDelivery(validDelivery(), { nowMs: NOW });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.text, "hello");
    assert.equal(result.value.route.chatId, "123");
    assert.equal(result.value.route.threadId, undefined);
  }
});

test("accepts optional threadId", () => {
  const result = validateStaticDelivery(
    validDelivery({
      route: {
        profileId: "profile-a",
        adapterId: "telegram",
        accountId: "bot-1",
        chatId: "123",
        threadId: "t-9",
      },
    }),
    { nowMs: NOW },
  );
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.route.threadId, "t-9");
});

test("rejects missing route fields", () => {
  const result = validateStaticDelivery(
    validDelivery({
      route: { profileId: "profile-a", adapterId: "telegram", accountId: "bot-1" },
    }),
    { nowMs: NOW },
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "invalid_route");
});

test("rejects empty or oversized route fields", () => {
  const result = validateStaticDelivery(
    validDelivery({
      route: {
        profileId: "",
        adapterId: "telegram",
        accountId: "bot-1",
        chatId: "123",
      },
    }),
    { nowMs: NOW },
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "invalid_route");
});

test("rejects empty text", () => {
  const result = validateStaticDelivery(validDelivery({ text: "" }), { nowMs: NOW });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "invalid_body");
});

test("rejects oversized text using UTF-16 code units", () => {
  const result = validateStaticDelivery(
    validDelivery({ text: "a".repeat(LIMITS.maxTextChars + 1) }),
    { nowMs: NOW },
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "text_too_long");
});

test("rejects notAfter at or before now", () => {
  const result = validateStaticDelivery(validDelivery({ notAfter: NOW }), { nowMs: NOW });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "invalid_not_after");
});

test("rejects notAfter beyond 24 hours", () => {
  const result = validateStaticDelivery(
    validDelivery({ notAfter: NOW + LIMITS.maxNotAfterMs + 1 }),
    { nowMs: NOW },
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "invalid_not_after");
});
