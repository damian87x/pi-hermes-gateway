import assert from "node:assert/strict";
import { test } from "node:test";
import { LIMITS, validateStaticDelivery } from "pi-hermes-gateway-protocol";
import { jobNotAfter, TestClock } from "../dist/index.js";
import { cleanup, handle, openTestGw, ROUTE } from "./helpers.ts";

test("S0 validateStaticDelivery cannot express scheduledInstant-anchored notAfter for a future slot", () => {
  const now = Date.UTC(2026, 0, 1, 10, 0, 0);
  const scheduled = now + 60 * 60 * 1000;
  const notAfter = jobNotAfter(scheduled, LIMITS.maxNotAfterMs);
  const result = validateStaticDelivery({ route: ROUTE, text: "job", notAfter }, { nowMs: now });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "invalid_not_after");
});

test("job delivery notAfter anchors to scheduledInstant, not catch-up now", () => {
  const clock = new TestClock(Date.UTC(2026, 0, 1, 10, 0, 0));
  const { gw, dir, adapter } = openTestGw({ clock, catchUpPolicy: "one-latest", notAfterBoundMs: LIMITS.maxNotAfterMs });
  handle(gw, "job.create", {
    kind: "static-text",
    text: "anchor",
    route: ROUTE,
    schedule: { type: "once", atUtc: "2026-01-01T08:00:00.000Z" },
  }, clock.nowMs());
  gw.tick();
  const occ = gw.store.listOccurrences();
  assert.equal(occ.length, 1);
  const dlv = gw.store.listDeliveries()[0];
  assert.ok(dlv);
  assert.equal(dlv.not_after_ms, Date.parse("2026-01-01T08:00:00.000Z") + LIMITS.maxNotAfterMs);
  assert.equal(adapter.sent.length, 1);
  gw.close();
  cleanup(dir);
});

test("expired job occurrence is never sent late", () => {
  const bound = 60 * 60 * 1000;
  const clock = new TestClock(Date.UTC(2026, 0, 1, 10, 0, 0));
  const { gw, dir, adapter } = openTestGw({ clock, catchUpPolicy: "one-latest", notAfterBoundMs: bound });
  handle(gw, "job.create", {
    kind: "static-text",
    text: "late",
    route: ROUTE,
    schedule: { type: "once", atUtc: "2026-01-01T08:00:00.000Z" },
  }, clock.nowMs());
  gw.tick();
  assert.equal(adapter.sent.length, 0);
  const occ = gw.store.listOccurrences();
  assert.equal(occ[0]?.status, "expired");
  gw.close();
  cleanup(dir);
});

test("operator enqueue keeps protocol now-relative notAfter and rejects overdue dispatch", () => {
  const clock = new TestClock(Date.UTC(2026, 0, 1, 10, 0, 0));
  const { gw, dir, adapter } = openTestGw({ clock });
  const notAfter = clock.nowMs() + 5_000;
  const enq = handle(gw, "delivery.enqueue", { route: ROUTE, text: "static", notAfter }, clock.nowMs());
  assert.equal(enq.ok, true);
  assert.equal(adapter.sent.length, 1);
  const bad = handle(gw, "delivery.enqueue", { route: ROUTE, text: "too-far", notAfter: clock.nowMs() + LIMITS.maxNotAfterMs + 1 }, clock.nowMs());
  assert.equal(bad.ok, false);
  gw.close();
  cleanup(dir);
});
