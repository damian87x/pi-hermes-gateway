import assert from "node:assert/strict";
import { test } from "node:test";
import { dailyInstantsInRange, DEFAULT_CONFIG, DEFAULT_TICK_INTERVAL_MS, zonedLocalInstant } from "../dist/index.js";
import { TestClock } from "../dist/index.js";
import { cleanup, handle, openTestGw, ROUTE } from "./helpers.ts";

function bruteFirst(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): number | null {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const start = Date.UTC(year, month - 1, day) - 36 * 3_600_000;
  const end = Date.UTC(year, month - 1, day + 1) + 36 * 3_600_000;
  for (let t = start; t <= end; t += 60_000) {
    const map: Record<string, string> = {};
    for (const p of fmt.formatToParts(new Date(t))) {
      if (p.type !== "literal") map[p.type] = p.value;
    }
    const hourRaw = Number(map.hour);
    if (
      Number(map.year) === year &&
      Number(map.month) === month &&
      Number(map.day) === day &&
      (hourRaw === 24 ? 0 : hourRaw) === hour &&
      Number(map.minute) === minute &&
      Number(map.second) === 0
    ) {
      return t;
    }
  }
  return null;
}

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

test("DST AU/NZ first fold, gaps, and adjacent valid local times vs brute-force oracle", () => {
  const cases: Array<[string, number, number, number, number, number]> = [
    ["Europe/London", 2026, 3, 29, 1, 30],
    ["Europe/London", 2026, 10, 25, 1, 30],
    ["America/New_York", 2026, 3, 8, 2, 30],
    ["America/New_York", 2026, 11, 1, 1, 30],
    ["Europe/Berlin", 2026, 10, 25, 2, 30],
    ["Australia/Sydney", 2026, 4, 5, 2, 30],
    ["Australia/Sydney", 2026, 4, 5, 1, 30],
    ["Australia/Sydney", 2026, 10, 4, 2, 30],
    ["Australia/Sydney", 2026, 10, 4, 1, 30],
    ["Pacific/Auckland", 2026, 4, 5, 2, 30],
    ["Pacific/Auckland", 2026, 4, 5, 1, 30],
    ["Pacific/Auckland", 2026, 9, 27, 2, 30],
    ["Pacific/Auckland", 2026, 9, 27, 1, 30],
    ["Australia/Lord_Howe", 2026, 4, 5, 1, 45],
  ];
  for (const [tz, y, m, d, h, min] of cases) {
    assert.equal(zonedLocalInstant(tz, y, m, d, h, min), bruteFirst(tz, y, m, d, h, min), `${tz} ${y}-${m}-${d} ${h}:${min}`);
  }
  const sydney = dailyInstantsInRange({
    timeZone: "Australia/Sydney",
    localTime: "01:30",
    afterMs: Date.UTC(2026, 3, 2),
    toMs: Date.UTC(2026, 3, 6),
  });
  assert.deepEqual(sydney, [
    Date.UTC(2026, 3, 2, 14, 30, 0),
    Date.UTC(2026, 3, 3, 14, 30, 0),
    Date.UTC(2026, 3, 4, 14, 30, 0),
    Date.UTC(2026, 3, 5, 15, 30, 0),
  ]);
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

test("interval-sized gap plus millisecond lateness still sends under skip", () => {
  const interval = DEFAULT_TICK_INTERVAL_MS;
  const grace = DEFAULT_CONFIG.tickGraceMs;
  assert.ok(grace > interval, "grace must exceed tick interval");
  const S = Date.UTC(2026, 0, 1, 12, 0, 0);
  const clock = new TestClock(S - 1);
  const { gw, dir, adapter } = openTestGw({ clock, catchUpPolicy: "skip" });
  handle(
    gw,
    "job.create",
    {
      kind: "static-text",
      text: "noon",
      route: ROUTE,
      schedule: { type: "daily", localTime: "12:00", timeZone: "UTC" },
    },
    clock.nowMs(),
  );
  gw.tick();
  assert.equal(adapter.sent.length, 0);
  clock.add(interval + 2);
  gw.tick();
  assert.equal(adapter.sent.length, 1);
  const occ = gw.store.listOccurrences();
  assert.equal(occ.length, 1);
  assert.equal(occ[0]?.status, "completed");
  gw.close();
  cleanup(dir);
});
