import assert from "node:assert/strict";
import { test } from "node:test";
import { validateMethodBody, validateWireRequest } from "../dist/index.js";
import { NOW, frameFor } from "./helpers.ts";

const route = {
  profileId: "profile-a",
  adapterId: "telegram",
  accountId: "bot-1",
  chatId: "123",
};

test("accepts job.create static-text once-at body", () => {
  const body = {
    kind: "static-text",
    text: "ping",
    route,
    schedule: { type: "once", atUtc: "2026-09-21T00:00:00.000Z" },
  };
  const result = validateMethodBody("job.create", body, { nowMs: NOW });
  assert.equal(result.ok, true);
});

test("accepts job.create daily local schedule with IANA zone", () => {
  const body = {
    kind: "static-text",
    text: "ping",
    route,
    schedule: { type: "daily", localTime: "09:30", timeZone: "Europe/Warsaw" },
  };
  const result = validateMethodBody("job.create", body, { nowMs: NOW });
  assert.equal(result.ok, true);
});

test("rejects worker job kinds in S0/M1 protocol", () => {
  const result = validateMethodBody(
    "job.create",
    {
      kind: "worker-report",
      text: "no",
      route,
      schedule: { type: "once", atUtc: "2026-09-21T00:00:00.000Z" },
    },
    { nowMs: NOW },
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "invalid_body");
});

test("rejects unknown IANA time zones", () => {
  const result = validateMethodBody(
    "job.create",
    {
      kind: "static-text",
      text: "ping",
      route,
      schedule: { type: "daily", localTime: "09:30", timeZone: "Not/AZone" },
    },
    { nowMs: NOW },
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "invalid_body");
});

test("rejects invalid localTime", () => {
  const result = validateMethodBody(
    "job.create",
    {
      kind: "static-text",
      text: "ping",
      route,
      schedule: { type: "daily", localTime: "9:30", timeZone: "UTC" },
    },
    { nowMs: NOW },
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "invalid_body");
});

test("validates job.inspect and delivery.enqueue bodies", () => {
  const inspect = validateMethodBody("job.inspect", { jobId: "job-1" }, { nowMs: NOW });
  assert.equal(inspect.ok, true);
  const enqueue = validateMethodBody(
    "delivery.enqueue",
    { route, text: "hello", notAfter: NOW + 60_000 },
    { nowMs: NOW },
  );
  assert.equal(enqueue.ok, true);
});

test("rejects delivery.enqueue that fails static delivery rules", () => {
  const result = validateMethodBody(
    "delivery.enqueue",
    { route, text: "hello", notAfter: NOW },
    { nowMs: NOW },
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "invalid_not_after");
});

test("rejects nonexistent once-schedule calendar dates", () => {
  for (const atUtc of [
    "2026-02-30T00:00:00Z",
    "2026-02-30T00:00:00.000Z",
    "2026-04-31T00:00:00Z",
    "2026-02-29T00:00:00Z",
    "2026-02-29T24:00:00Z",
    "2026-06-31T00:00:00Z",
  ]) {
    const result = validateMethodBody(
      "job.create",
      { kind: "static-text", text: "ping", route, schedule: { type: "once", atUtc } },
      { nowMs: NOW },
    );
    assert.equal(result.ok, false, atUtc);
    if (!result.ok) assert.equal(result.error.code, "invalid_body");
  }
});

test("accepts valid UTC once-schedule forms including leap day, month boundaries, fractional seconds, and end-of-day", () => {
  for (const atUtc of [
    "2026-09-21T00:00:00Z",
    "2026-09-21T00:00:00.000Z",
    "2026-09-21T00:00:00.123Z",
    "2024-02-29T00:00:00Z",
    "2024-02-29T24:00:00Z",
    "2026-02-28T00:00:00Z",
    "2026-04-30T23:59:59Z",
    "2026-01-31T00:00:00Z",
    "2026-09-21T24:00:00Z",
    "2026-09-21T24:00:00.000Z",
  ]) {
    const result = validateMethodBody(
      "job.create",
      { kind: "static-text", text: "ping", route, schedule: { type: "once", atUtc } },
      { nowMs: NOW },
    );
    assert.equal(result.ok, true, atUtc);
  }
});

test("wire validation also checks method bodies", () => {
  const input = {
    protocolVersion: 1,
    requestId: "req-2",
    method: "job.pause",
    body: {},
    expiresAt: NOW + 1_000,
  };
  const result = validateWireRequest(input, { nowMs: NOW, frameByteLength: frameFor(input) });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "invalid_body");
});
