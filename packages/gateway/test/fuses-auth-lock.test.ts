import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { startDaemon, TestClock } from "../dist/index.js";
import { cleanup, handle, openTestGw, ROUTE, tmpDir, wire, frameLen } from "./helpers.ts";

test("per-account token bucket refuses extra sends with audit", () => {
  const { gw, clock, dir, adapter } = openTestGw({
    tokenBucketCapacity: 1,
    tokenBucketRefillPerMs: 0,
  });
  const a = handle(gw, "delivery.enqueue", { route: ROUTE, text: "one", notAfter: clock.nowMs() + 60_000 }, clock.nowMs());
  assert.equal(a.ok, true);
  const b = handle(gw, "delivery.enqueue", { route: ROUTE, text: "two", notAfter: clock.nowMs() + 60_000 }, clock.nowMs());
  assert.equal(b.ok, false);
  if (!b.ok) assert.equal(b.error.code, "rate_limited");
  assert.equal(adapter.sent.length, 1);
  assert.ok(gw.store.listAudit().some((r) => r.kind.includes("rejected")));
  gw.close();
  cleanup(dir);
});

test("per-route daily cap refuses with audit", () => {
  const { gw, clock, dir, adapter } = openTestGw({
    dailyCapPerRoute: 1,
    tokenBucketCapacity: 10,
  });
  handle(gw, "delivery.enqueue", { route: ROUTE, text: "one", notAfter: clock.nowMs() + 60_000 }, clock.nowMs());
  const b = handle(gw, "delivery.enqueue", { route: ROUTE, text: "two", notAfter: clock.nowMs() + 60_000 }, clock.nowMs());
  assert.equal(b.ok, false);
  if (!b.ok) assert.equal(b.error.code, "rate_limited");
  assert.equal(adapter.sent.length, 1);
  gw.close();
  cleanup(dir);
});

test("unauthorized route error is indistinguishable and audited", () => {
  const { gw, clock, dir } = openTestGw();
  const other = { ...ROUTE, chatId: "other-chat" };
  const a = handle(gw, "delivery.enqueue", { route: other, text: "nope", notAfter: clock.nowMs() + 60_000 }, clock.nowMs());
  const b = handle(gw, "job.create", {
    kind: "static-text",
    text: "nope",
    route: { ...ROUTE, accountId: "other-acct" },
    schedule: { type: "once", atUtc: "2026-01-02T00:00:00.000Z" },
  }, clock.nowMs());
  assert.equal(a.ok, false);
  assert.equal(b.ok, false);
  if (!a.ok && !b.ok) {
    assert.equal(a.error.code, b.error.code);
    assert.equal(a.error.message, b.error.message);
    assert.equal(a.error.code, "invalid_route");
  }
  assert.ok(gw.store.listAudit().some((r) => r.kind.endsWith(".attempt")));
  gw.close();
  cleanup(dir);
});

test("no IPC method creates routes; unknown method is rejected", () => {
  const { gw, clock, dir } = openTestGw();
  const req = wire("route.create", { route: ROUTE }, clock.nowMs());
  const res = gw.handleRequest(req, frameLen(req));
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.code, "unknown_method");
  gw.close();
  cleanup(dir);
});

test("request dedup returns the first response without a second send", () => {
  const { gw, clock, dir, adapter } = openTestGw();
  const reqId = "dup-1";
  const r1 = handle(gw, "delivery.enqueue", { route: ROUTE, text: "dup", notAfter: clock.nowMs() + 60_000 }, clock.nowMs(), reqId);
  const r2 = handle(gw, "delivery.enqueue", { route: ROUTE, text: "dup", notAfter: clock.nowMs() + 60_000 }, clock.nowMs(), reqId);
  assert.deepEqual(r1, r2);
  assert.equal(adapter.sent.length, 1);
  gw.close();
  cleanup(dir);
});

test("wrong profile mode fails closed", () => {
  const dir = tmpDir();
  mkdirSync(dir, { recursive: true, mode: 0o777 });
  chmodSync(dir, 0o777);
  const clock = new TestClock(Date.UTC(2026, 0, 1));
  assert.throws(() => {
    startDaemon({ profileDir: dir, routes: [ROUTE], clock, bindSocket: false });
  }, /0700/);
  cleanup(dir);
});

test("second daemon fails to lock and does not remove the first socket", () => {
  const dir = tmpDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({ routes: [ROUTE] }),
    { mode: 0o600 },
  );
  const clock = new TestClock(Date.UTC(2026, 0, 1, 10, 0, 0));
  const d1 = startDaemon({ profileDir: dir, routes: [ROUTE], clock, bindSocket: true });
  const sock = join(dir, "gateway.sock");
  assert.equal(existsSync(sock), true);
  assert.throws(() => {
    startDaemon({ profileDir: dir, routes: [ROUTE], clock, bindSocket: true });
  }, /profile lock held/);
  assert.equal(existsSync(sock), true);
  d1.stop();
  cleanup(dir);
});
