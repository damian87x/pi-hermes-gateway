import assert from "node:assert/strict";
import { test } from "node:test";
import { zonedLocalInstant } from "../dist/index.js";
import { TestClock } from "../dist/index.js";
import { cleanup, handle, openTestGw, ROUTE } from "./helpers.ts";

test("once-at UTC fires on the scheduled instant", () => {
  const { gw, clock, dir, adapter } = openTestGw();
  const at = "2026-01-01T12:00:00.000Z";
  const created = handle(gw, "job.create", {
    kind: "static-text",
    text: "once",
    route: ROUTE,
    schedule: { type: "once", atUtc: at },
  }, clock.nowMs());
  assert.equal(created.ok, true);
  gw.tick();
  assert.equal(adapter.sent.length, 0);
  clock.set(Date.parse(at));
  gw.tick();
  assert.equal(adapter.sent.length, 1);
  assert.equal(adapter.sent[0]?.text, "once");
  gw.close();
  cleanup(dir);
});

test("daily local IANA time fires", () => {
  const clock = new TestClock(Date.UTC(2026, 0, 1, 7, 0, 0));
  const { gw, dir, adapter } = openTestGw({ clock });
  const created = handle(gw, "job.create", {
    kind: "static-text",
    text: "daily",
    route: ROUTE,
    schedule: { type: "daily", localTime: "09:00", timeZone: "UTC" },
  }, clock.nowMs());
  assert.equal(created.ok, true);
  clock.set(Date.UTC(2026, 0, 1, 9, 0, 0));
  gw.tick();
  assert.equal(adapter.sent.length, 1);
  gw.close();
  cleanup(dir);
});

test("DST gap: skip nonexistent local time", () => {
  const instant = zonedLocalInstant("America/New_York", 2026, 3, 8, 2, 30);
  assert.equal(instant, null);
  const clock = new TestClock(Date.UTC(2026, 2, 7, 12, 0, 0));
  const { gw, dir, adapter } = openTestGw({ clock });
  handle(gw, "job.create", {
    kind: "static-text",
    text: "gap",
    route: ROUTE,
    schedule: { type: "daily", localTime: "02:30", timeZone: "America/New_York" },
  }, clock.nowMs());
  clock.set(Date.UTC(2026, 2, 9, 12, 0, 0));
  gw.tick();
  const occ = gw.store.listOccurrences();
  const gap = occ.filter((o) => {
    const d = new Date(o.scheduled_instant_ms);
    return d.getUTCFullYear() === 2026 && d.getUTCMonth() === 2 && d.getUTCDate() === 8;
  });
  assert.equal(gap.length, 0);
  assert.ok(adapter.sent.length <= 1);
  gw.close();
  cleanup(dir);
});

test("DST fold: first occurrence only", () => {
  const first = zonedLocalInstant("America/New_York", 2026, 11, 1, 1, 30);
  assert.equal(first, Date.UTC(2026, 10, 1, 5, 30, 0));
});

test("suspend past two due slots with skip: no burst", () => {
  const clock = new TestClock(Date.UTC(2026, 0, 1, 10, 0, 0));
  const { gw, dir, adapter } = openTestGw({ clock, catchUpPolicy: "skip" });
  handle(gw, "job.create", {
    kind: "static-text",
    text: "skip-burst",
    route: ROUTE,
    schedule: { type: "daily", localTime: "09:00", timeZone: "UTC" },
  }, clock.nowMs());
  clock.set(Date.UTC(2026, 0, 3, 10, 0, 0));
  gw.tick();
  assert.equal(adapter.sent.length, 0);
  const occ = gw.store.listOccurrences();
  assert.equal(occ.length, 2);
  assert.ok(occ.every((o) => o.status === "skipped"));
  gw.close();
  cleanup(dir);
});

test("suspend past two due slots with one-latest: single unexpired catch-up", () => {
  const clock = new TestClock(Date.UTC(2026, 0, 1, 10, 0, 0));
  const { gw, dir, adapter } = openTestGw({ clock, catchUpPolicy: "one-latest" });
  handle(gw, "job.create", {
    kind: "static-text",
    text: "latest",
    route: ROUTE,
    schedule: { type: "daily", localTime: "09:00", timeZone: "UTC" },
  }, clock.nowMs());
  clock.set(Date.UTC(2026, 0, 3, 10, 0, 0));
  gw.tick();
  assert.equal(adapter.sent.length, 1);
  const occ = gw.store.listOccurrences();
  assert.equal(occ.length, 2);
  const skipped = occ.filter((o) => o.status === "skipped");
  const done = occ.filter((o) => o.status === "completed");
  assert.equal(skipped.length, 1);
  assert.equal(done.length, 1);
  assert.equal(done[0]?.scheduled_instant_ms, Date.UTC(2026, 0, 3, 9, 0, 0));
  gw.close();
  cleanup(dir);
});
