import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import type { DeliveryRoute } from "pi-hermes-gateway-protocol";
import { createFakeAdapter, openGateway, TestClock, type FakeAdapter, type Gateway, type Store } from "../dist/index.js";
import { cleanup, handle, ROUTE, tmpDir } from "./helpers.ts";

const START_MS = Date.UTC(2026, 0, 1, 10, 0, 0);
const AT = "2026-01-01T10:01:00.000Z";
const BOUND_MS = 60_000;
const SQLITE_BUSY = 5;

function open(dbPath: string, clock: TestClock, routes: DeliveryRoute[] = [ROUTE]): { gw: Gateway; adapter: FakeAdapter } {
  const adapter = createFakeAdapter();
  const { gateway } = openGateway({ dbPath, clock, routes, adapter, notAfterBoundMs: BOUND_MS });
  return { gw: gateway, adapter };
}

// A second gateway with its own Store connection on the same ledger, standing in for another process
// (CLI or IPC server). busy_timeout 0 makes a request that meets the dispatch writer lock fail at once
// rather than block this single thread; a real process would wait and then run after the commit.
function openOtherWriter(dbPath: string, clock: TestClock): Gateway {
  const { gw } = open(dbPath, clock);
  gw.store.db.exec("PRAGMA busy_timeout = 0");
  return gw;
}

function tryJobRequest(other: Gateway, method: string, jobId: string, requestId: string): "committed" | "busy" {
  try {
    const res = handle(other, method, { jobId }, other.clock.nowMs(), requestId);
    assert.equal(res.ok, true);
    return "committed";
  } catch (err) {
    if (((err as { errcode?: number }).errcode ?? 0) % 256 === SQLITE_BUSY) return "busy";
    throw err;
  }
}

// Runs `race` once, right after the first call of `method` on `store` that `when` selects.
function raceAfter<K extends "getOccurrence" | "setOccurrenceStatus" | "getAccountFuse" | "listJobs" | "getDelivery">(
  t: TestContext,
  store: Store,
  method: K,
  when: (args: unknown[]) => boolean,
  race: () => string,
): string[] {
  const outcomes: string[] = [];
  const original = (store[method] as (...args: unknown[]) => unknown).bind(store);
  t.mock.method(store, method, (...args: unknown[]) => {
    const result = original(...args);
    if (outcomes.length === 0 && when(args)) outcomes.push(race());
    return result;
  });
  return outcomes;
}

function createOnceJob(gw: Gateway): string {
  const res = handle(gw, "job.create", { kind: "static-text", text: "raced", route: ROUTE, schedule: { type: "once", atUtc: AT } }, gw.clock.nowMs());
  assert.equal(res.ok, true);
  return (res as { body: { jobId: string } }).body.jobId;
}

// Admits the job's occurrence with dispatch disabled, so its delivery is left queued for the raced dispatch.
function queueJobDelivery(gw: Gateway, clock: TestClock): { jobId: string; deliveryId: string; occurrenceId: string } {
  const jobId = createOnceJob(gw);
  gw.store.setMeta("dispatch_enabled", "0");
  clock.set(Date.parse(AT));
  gw.tick();
  const [row] = gw.store.listDeliveries();
  assert.equal(row?.status, "queued");
  assert.equal(gw.store.getOccurrence(row.occurrence_id!)?.status, "pending");
  gw.store.setMeta("dispatch_enabled", "1");
  return { jobId, deliveryId: row.delivery_id, occurrenceId: row.occurrence_id! };
}

function auditCount(gw: Gateway, kind: string): number {
  return gw.store.listAudit().filter((a) => a.kind === kind).length;
}

function fuseState(gw: Gateway): { tokens: number | null; dayCount: number } {
  const account = gw.store.getAccountFuse(ROUTE.accountId);
  const day = gw.store.db.prepare("SELECT COALESCE(SUM(count), 0) AS n FROM fuse_route_day").get();
  return { tokens: account ? account.tokens : null, dayCount: Number(day?.n) };
}

type Ledger = {
  job: string | undefined;
  delivery: string | undefined;
  intent: number | undefined;
  occurrence: string | undefined;
  audits: Record<string, number>;
  fuse: { tokens: number | null; dayCount: number };
  cancelLogged: boolean;
};

const AUDIT_KINDS = [
  "delivery.send.attempt",
  "delivery.accepted",
  "delivery.expired",
  "delivery.send.rejected",
  "delivery.cancelled",
  "job.cancelled",
  "job.paused",
  "occurrence.admitted",
];

function ledger(gw: Gateway, ids: { jobId: string; deliveryId: string; occurrenceId: string }, requestId: string): Ledger {
  const delivery = gw.store.getDelivery(ids.deliveryId);
  return {
    job: gw.store.getJob(ids.jobId)?.status,
    delivery: delivery?.status,
    intent: delivery?.dispatch_intent,
    occurrence: gw.store.getOccurrence(ids.occurrenceId)?.status,
    audits: Object.fromEntries(AUDIT_KINDS.map((kind) => [kind, auditCount(gw, kind)])),
    fuse: fuseState(gw),
    cancelLogged: gw.store.getRequest(requestId) !== null,
  };
}

function audits(counts: Partial<Record<string, number>>): Record<string, number> {
  return Object.fromEntries(AUDIT_KINDS.map((kind) => [kind, counts[kind] ?? 0]));
}

// Restarts twice and ticks past the schedule; a settled ledger must not change or send.
function assertRestartIsInert(dbPath: string, clock: TestClock, ids: { jobId: string; deliveryId: string; occurrenceId: string }, expected: Ledger): void {
  const { gw, adapter } = open(dbPath, clock);
  try {
    gw.tick();
    clock.add(60_000);
    gw.tick();
    assert.equal(adapter.sent.length, 0, "restart never sends");
    assert.deepEqual(ledger(gw, ids, "race-cancel"), expected);
  } finally {
    gw.close();
  }
}

const dispatchWindows = [
  {
    name: "after dispatch reads the occurrence pending, before the claim",
    method: "getOccurrence" as const,
    when: () => true,
    pastNotAfter: false,
  },
  {
    name: "after dispatch claims the occurrence, before the expiry write",
    method: "setOccurrenceStatus" as const,
    when: (args: unknown[]) => args[1] === "claimed",
    pastNotAfter: true,
  },
  {
    name: "at the fuse read, before the debit and dispatch intent",
    method: "getAccountFuse" as const,
    when: () => true,
    pastNotAfter: false,
  },
];

for (const window of dispatchWindows) {
  test(`job.cancel from a second Store ${window.name} waits for the dispatch writer lock; neither overwrites the other and restart never resends`, (t) => {
    const dir = tmpDir();
    const dbPath = join(dir, "gateway.sqlite");
    const clock = new TestClock(START_MS);
    const { gw, adapter } = open(dbPath, clock);
    const other = openOtherWriter(dbPath, clock);
    const ids = queueJobDelivery(gw, clock);
    if (window.pastNotAfter) clock.add(BOUND_MS);

    const outcomes = raceAfter(t, gw.store, window.method, window.when, () => tryJobRequest(other, "job.cancel", ids.jobId, "race-cancel"));
    gw.processOutbox();
    t.mock.restoreAll();
    assert.deepEqual(outcomes, ["busy"], "the cancel cannot commit inside the dispatch transaction");

    const sentOutcome: Ledger = window.pastNotAfter
      ? {
          job: "active",
          delivery: "expired",
          intent: 0,
          occurrence: "expired",
          audits: audits({ "delivery.send.attempt": 1, "delivery.expired": 1, "occurrence.admitted": 1 }),
          fuse: { tokens: null, dayCount: 0 },
          cancelLogged: false,
        }
      : {
          job: "active",
          delivery: "accepted",
          intent: 1,
          occurrence: "completed",
          audits: audits({ "delivery.send.attempt": 1, "delivery.accepted": 1, "occurrence.admitted": 1 }),
          fuse: { tokens: 4, dayCount: 1 },
          cancelLogged: false,
        };
    assert.equal(adapter.sent.length, window.pastNotAfter ? 0 : 1);
    assert.deepEqual(ledger(gw, ids, "race-cancel"), sentOutcome);

    // The waiting cancel runs after the commit: it cancels the job and leaves the settled delivery alone.
    assert.equal(tryJobRequest(other, "job.cancel", ids.jobId, "race-cancel"), "committed");
    const settled: Ledger = {
      ...sentOutcome,
      job: "cancelled",
      audits: { ...sentOutcome.audits, "job.cancelled": 1 },
      cancelLogged: true,
    };
    assert.deepEqual(ledger(gw, ids, "race-cancel"), settled);
    other.close();
    gw.close();

    assertRestartIsInert(dbPath, clock, ids, settled);
    cleanup(dir);
  });
}

test("job.cancel from a second Store after dispatch reads the row queued, before the dispatch lock, fails it with no claim, debit or send", (t) => {
  const dir = tmpDir();
  const dbPath = join(dir, "gateway.sqlite");
  const clock = new TestClock(START_MS);
  const { gw, adapter } = open(dbPath, clock);
  const other = openOtherWriter(dbPath, clock);
  const ids = queueJobDelivery(gw, clock);

  const outcomes = raceAfter(
    t,
    gw.store,
    "getDelivery",
    (args) => args[0] === ids.deliveryId && !gw.store.db.isTransaction,
    () => tryJobRequest(other, "job.cancel", ids.jobId, "race-cancel"),
  );
  gw.processOutbox();
  t.mock.restoreAll();
  assert.deepEqual(outcomes, ["committed"]);

  const expected: Ledger = {
    job: "cancelled",
    delivery: "failed",
    intent: 0,
    occurrence: "skipped",
    audits: audits({ "delivery.cancelled": 1, "job.cancelled": 1, "occurrence.admitted": 1 }),
    fuse: { tokens: null, dayCount: 0 },
    cancelLogged: true,
  };
  assert.equal(adapter.sent.length, 0);
  assert.deepEqual(ledger(gw, ids, "race-cancel"), expected);
  other.close();
  gw.close();

  assertRestartIsInert(dbPath, clock, ids, expected);
  cleanup(dir);
});

test("job.pause from a second Store before the dispatch lock holds the row queued across restart; resume sends it once", (t) => {
  const dir = tmpDir();
  const dbPath = join(dir, "gateway.sqlite");
  const clock = new TestClock(START_MS);
  const { gw, adapter } = open(dbPath, clock);
  const other = openOtherWriter(dbPath, clock);
  const ids = queueJobDelivery(gw, clock);

  const outcomes = raceAfter(
    t,
    gw.store,
    "getDelivery",
    (args) => args[0] === ids.deliveryId && !gw.store.db.isTransaction,
    () => tryJobRequest(other, "job.pause", ids.jobId, "race-pause"),
  );
  gw.processOutbox();
  t.mock.restoreAll();
  assert.deepEqual(outcomes, ["committed"]);

  const held: Ledger = {
    job: "paused",
    delivery: "queued",
    intent: 0,
    occurrence: "pending",
    audits: audits({ "job.paused": 1, "occurrence.admitted": 1 }),
    fuse: { tokens: null, dayCount: 0 },
    cancelLogged: false,
  };
  assert.equal(adapter.sent.length, 0);
  assert.deepEqual(ledger(gw, ids, "race-cancel"), held);
  other.close();
  gw.close();

  const { gw: reopened, adapter: fresh } = open(dbPath, clock);
  try {
    reopened.tick();
    assert.equal(fresh.sent.length, 0);
    assert.deepEqual(ledger(reopened, ids, "race-cancel"), held);
    assert.equal(handle(reopened, "job.resume", { jobId: ids.jobId }, clock.nowMs()).ok, true);
    reopened.tick();
    reopened.tick();
    assert.deepEqual(fresh.sent.map((e) => e.deliveryId), [ids.deliveryId]);
    assert.deepEqual(ledger(reopened, ids, "race-cancel"), {
      ...held,
      job: "active",
      delivery: "accepted",
      intent: 1,
      occurrence: "completed",
      audits: { ...held.audits, "delivery.send.attempt": 1, "delivery.accepted": 1 },
      fuse: { tokens: 4, dayCount: 1 },
    });
  } finally {
    reopened.close();
  }
  cleanup(dir);
});

test("job.cancel from a second Store after tick's active-job snapshot, before admission, admits and audits nothing for the cancelled job", (t) => {
  const dir = tmpDir();
  const dbPath = join(dir, "gateway.sqlite");
  const clock = new TestClock(START_MS);
  const { gw, adapter } = open(dbPath, clock);
  const other = openOtherWriter(dbPath, clock);
  const jobId = createOnceJob(gw);
  clock.set(Date.parse(AT));

  const outcomes = raceAfter(t, gw.store, "listJobs", () => true, () => tryJobRequest(other, "job.cancel", jobId, "race-cancel"));
  gw.tick();
  t.mock.restoreAll();
  assert.deepEqual(outcomes, ["committed"]);

  const assertNothingAdmitted = (target: Gateway) => {
    assert.equal(target.store.getJob(jobId)?.status, "cancelled");
    assert.deepEqual(target.store.listOccurrences(jobId), []);
    assert.deepEqual(target.store.listDeliveries(), []);
    assert.equal(auditCount(target, "occurrence.admitted"), 0);
    assert.equal(auditCount(target, "delivery.send.attempt"), 0);
    assert.equal(auditCount(target, "delivery.cancelled"), 0);
    assert.equal(auditCount(target, "job.cancelled"), 1);
    assert.notEqual(target.store.getRequest("race-cancel"), null);
    assert.deepEqual(fuseState(target), { tokens: null, dayCount: 0 });
  };
  assert.equal(adapter.sent.length, 0);
  assertNothingAdmitted(gw);
  other.close();
  gw.close();

  const { gw: reopened, adapter: fresh } = open(dbPath, clock);
  try {
    reopened.tick();
    clock.add(60_000);
    reopened.tick();
    assert.equal(fresh.sent.length, 0);
    assertNothingAdmitted(reopened);
  } finally {
    reopened.close();
  }
  cleanup(dir);
});

test("job.pause from a second Store after tick's active-job snapshot admits a held queued row; resume sends it once", (t) => {
  const dir = tmpDir();
  const dbPath = join(dir, "gateway.sqlite");
  const clock = new TestClock(START_MS);
  const { gw, adapter } = open(dbPath, clock);
  const other = openOtherWriter(dbPath, clock);
  const jobId = createOnceJob(gw);
  clock.set(Date.parse(AT));

  const outcomes = raceAfter(t, gw.store, "listJobs", () => true, () => tryJobRequest(other, "job.pause", jobId, "race-pause"));
  gw.tick();
  t.mock.restoreAll();
  assert.deepEqual(outcomes, ["committed"]);

  const [row] = gw.store.listDeliveries();
  assert.ok(row);
  const ids = { jobId, deliveryId: row.delivery_id, occurrenceId: row.occurrence_id! };
  const held: Ledger = {
    job: "paused",
    delivery: "queued",
    intent: 0,
    occurrence: "pending",
    audits: audits({ "job.paused": 1, "occurrence.admitted": 1 }),
    fuse: { tokens: null, dayCount: 0 },
    cancelLogged: false,
  };
  assert.equal(adapter.sent.length, 0);
  assert.deepEqual(ledger(gw, ids, "race-cancel"), held);
  assert.equal(handle(gw, "job.resume", { jobId }, clock.nowMs()).ok, true);
  gw.tick();
  gw.tick();
  assert.deepEqual(adapter.sent.map((e) => e.deliveryId), [ids.deliveryId]);
  assert.equal(gw.store.getDelivery(ids.deliveryId)?.status, "accepted");
  assert.equal(gw.store.getOccurrence(ids.occurrenceId)?.status, "completed");
  other.close();
  gw.close();
  cleanup(dir);
});

for (const path of [
  { name: "dispatch-time expiry", routes: [ROUTE], pastNotAfter: true, trigger: "BEFORE UPDATE ON deliveries WHEN NEW.status = 'expired'" },
  { name: "revoked-route refusal", routes: [], pastNotAfter: false, trigger: "BEFORE UPDATE ON deliveries WHEN NEW.status = 'failed'" },
]) {
  test(`${path.name} whose write fails rolls back the claim; a second-Store cancel then fails the row once and restart never sends or overwrites it`, () => {
    const dir = tmpDir();
    const dbPath = join(dir, "gateway.sqlite");
    const clock = new TestClock(START_MS);
    const first = open(dbPath, clock);
    const ids = queueJobDelivery(first.gw, clock);
    first.gw.close();
    if (path.pastNotAfter) clock.add(BOUND_MS);

    const side = new DatabaseSync(dbPath);
    side.exec(`CREATE TRIGGER block_terminal ${path.trigger} BEGIN SELECT RAISE(ABORT, 'injected terminal write failure'); END`);
    const { gw, adapter } = open(dbPath, clock, path.routes);
    gw.processOutbox();
    assert.ok(gw.outboxHalt, "the failed terminal write halts the outbox");
    assert.equal(adapter.sent.length, 0);
    assert.deepEqual(ledger(gw, ids, "race-cancel"), {
      job: "active",
      delivery: "queued",
      intent: 0,
      occurrence: "pending",
      audits: audits({ "occurrence.admitted": 1 }),
      fuse: { tokens: null, dayCount: 0 },
      cancelLogged: false,
    });
    side.exec("DROP TRIGGER block_terminal");
    side.close();

    const other = openOtherWriter(dbPath, clock);
    assert.equal(tryJobRequest(other, "job.cancel", ids.jobId, "race-cancel"), "committed");
    other.close();
    const cancelled: Ledger = {
      job: "cancelled",
      delivery: "failed",
      intent: 0,
      occurrence: "skipped",
      audits: audits({ "delivery.cancelled": 1, "job.cancelled": 1, "occurrence.admitted": 1 }),
      fuse: { tokens: null, dayCount: 0 },
      cancelLogged: true,
    };
    assert.deepEqual(ledger(gw, ids, "race-cancel"), cancelled);
    gw.close();

    assertRestartIsInert(dbPath, clock, ids, cancelled);
    cleanup(dir);
  });
}

const MISSED_MS = Date.parse(AT) + 10 * 60_000;

for (const race of [
  { method: "job.cancel", status: "cancelled" },
  { method: "job.pause", status: "paused" },
]) {
  test(`${race.method} from a second Store after tick's active-job snapshot, before a missed slot, records no skip and keeps the watermark`, (t) => {
    const dir = tmpDir();
    const dbPath = join(dir, "gateway.sqlite");
    const clock = new TestClock(START_MS);
    const { gw, adapter } = open(dbPath, clock);
    const other = openOtherWriter(dbPath, clock);
    const jobId = createOnceJob(gw);
    clock.set(MISSED_MS);

    const outcomes = raceAfter(t, gw.store, "listJobs", () => true, () => tryJobRequest(other, race.method, jobId, "race-request"));
    gw.tick();
    t.mock.restoreAll();
    assert.deepEqual(outcomes, ["committed"]);

    const assertNothingRecorded = (target: Gateway) => {
      assert.equal(target.store.getJob(jobId)?.status, race.status);
      assert.equal(target.store.getJob(jobId)?.watermark_ms, START_MS);
      assert.deepEqual(target.store.listOccurrences(jobId), []);
      assert.deepEqual(target.store.listDeliveries(), []);
      assert.equal(auditCount(target, "occurrence.skipped"), 0);
      assert.equal(auditCount(target, `job.${race.status}`), 1);
    };
    assert.equal(adapter.sent.length, 0);
    assertNothingRecorded(gw);
    other.close();
    gw.close();

    const { gw: reopened, adapter: fresh } = open(dbPath, clock);
    try {
      reopened.tick();
      clock.add(60_000);
      reopened.tick();
      assert.equal(fresh.sent.length, 0);
      assertNothingRecorded(reopened);
    } finally {
      reopened.close();
    }
    cleanup(dir);
  });
}

test("job.cancel from a second Store between two missed slots keeps the earlier skip and records no later skip or watermark", (t) => {
  const dir = tmpDir();
  const dbPath = join(dir, "gateway.sqlite");
  const clock = new TestClock(START_MS);
  const { gw, adapter } = open(dbPath, clock);
  const other = openOtherWriter(dbPath, clock);
  const res = handle(
    gw,
    "job.create",
    { kind: "static-text", text: "raced", route: ROUTE, schedule: { type: "daily", localTime: "10:01", timeZone: "UTC" } },
    clock.nowMs(),
  );
  assert.equal(res.ok, true);
  const jobId = (res as { body: { jobId: string } }).body.jobId;
  clock.set(MISSED_MS + 24 * 60 * 60_000);

  // Fires before the first store call outside a transaction once the first missed skip is written:
  // the next slot's own skip check, or its writer transaction.
  const outcomes: string[] = [];
  for (const method of ["findOccurrence", "transaction"] as const) {
    const original = (gw.store[method] as (...args: unknown[]) => unknown).bind(gw.store);
    t.mock.method(gw.store, method, (...args: unknown[]) => {
      if (outcomes.length === 0 && !gw.store.db.isTransaction && auditCount(gw, "occurrence.skipped") === 1) {
        outcomes.push(tryJobRequest(other, "job.cancel", jobId, "race-cancel"));
      }
      return original(...args);
    });
  }
  gw.tick();
  t.mock.restoreAll();
  assert.deepEqual(outcomes, ["committed"]);

  const firstSlot = Date.parse(AT);
  const assertOnlyEarlierSkip = (target: Gateway) => {
    assert.equal(target.store.getJob(jobId)?.status, "cancelled");
    assert.equal(target.store.getJob(jobId)?.watermark_ms, START_MS);
    assert.deepEqual(
      target.store.listOccurrences(jobId).map((o) => [o.scheduled_instant_ms, o.status]),
      [[firstSlot, "skipped"]],
    );
    assert.deepEqual(target.store.listDeliveries(), []);
    assert.equal(auditCount(target, "occurrence.skipped"), 1);
    assert.equal(auditCount(target, "job.cancelled"), 1);
  };
  assert.equal(adapter.sent.length, 0);
  assertOnlyEarlierSkip(gw);
  other.close();
  gw.close();

  const { gw: reopened, adapter: fresh } = open(dbPath, clock);
  try {
    reopened.tick();
    clock.add(24 * 60 * 60_000);
    reopened.tick();
    assert.equal(fresh.sent.length, 0);
    assertOnlyEarlierSkip(reopened);
  } finally {
    reopened.close();
  }
  cleanup(dir);
});
