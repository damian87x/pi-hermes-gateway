import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanup, handle, openTestGw, ROUTE } from "./helpers.ts";

function enqueueNow(gw: ReturnType<typeof openTestGw>["gw"], clockNow: number, text = "x") {
  return handle(gw, "delivery.enqueue", { route: ROUTE, text, notAfter: clockNow + 60_000 }, clockNow);
}

test("crash at claim: interrupted, not accepted, later tick does not send", () => {
  const { gw, clock, dir, adapter } = openTestGw();
  gw.crashNext = "claim";
  enqueueNow(gw, clock.nowMs());
  assert.equal(adapter.sent.length, 0);
  const occOrDlv = gw.store.listDeliveries()[0];
  assert.ok(occOrDlv);
  gw.crashNext = null;
  gw.processOutbox();
  assert.equal(adapter.sent.length, 0);
  gw.close();
  cleanup(dir);
});

test("crash at dispatch-intent: commit-unknown never auto-retried", () => {
  const { gw, clock, dir, adapter } = openTestGw();
  gw.crashNext = "dispatch-intent";
  enqueueNow(gw, clock.nowMs());
  const row = gw.store.listDeliveries()[0];
  assert.equal(row?.status, "commit-unknown");
  assert.equal(adapter.sent.length, 0);
  gw.processOutbox();
  assert.equal(adapter.sent.length, 0);
  assert.equal(gw.store.getDelivery(row!.delivery_id)?.status, "commit-unknown");
  gw.close();
  cleanup(dir);
});

test("crash mid-send: commit-unknown never auto-retried", () => {
  const { gw, clock, dir, adapter } = openTestGw();
  gw.crashNext = "mid-send";
  enqueueNow(gw, clock.nowMs());
  const row = gw.store.listDeliveries()[0];
  assert.equal(row?.status, "commit-unknown");
  assert.equal(adapter.sent.length, 0);
  gw.processOutbox();
  assert.equal(adapter.sent.length, 0);
  gw.close();
  cleanup(dir);
});

test("crash before receipt write: commit-unknown even if adapter observed send", () => {
  const { gw, clock, dir, adapter } = openTestGw();
  gw.crashNext = "before-receipt";
  enqueueNow(gw, clock.nowMs());
  const row = gw.store.listDeliveries()[0];
  assert.equal(row?.status, "commit-unknown");
  assert.equal(adapter.sent.length, 1);
  gw.processOutbox();
  assert.equal(adapter.sent.length, 1);
  gw.close();
  cleanup(dir);
});

test("oversized adapter payload is rejected without send", () => {
  const { gw, clock, dir, adapter } = openTestGw();
  const text = "y".repeat(adapter.manifest.maxTextLength + 1);
  const res = handle(gw, "delivery.enqueue", { route: ROUTE, text, notAfter: clock.nowMs() + 60_000 }, clock.nowMs());
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.code, "text_too_long");
  assert.equal(adapter.sent.length, 0);
  gw.close();
  cleanup(dir);
});
