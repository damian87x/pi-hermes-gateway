import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { createFakeAdapter, openGateway, TestClock, type FakeAdapter, type Gateway, type Store } from "../dist/index.js";
import { cleanup, handle, ROUTE, tmpDir } from "./helpers.ts";

const START_MS = Date.UTC(2026, 0, 1, 10, 0, 0);
const AT = "2026-01-01T10:01:00.000Z";
const SQLITE_BUSY = 5;
const CREATE_BODY = { kind: "static-text", text: "raced", route: ROUTE, schedule: { type: "once", atUtc: AT } };

function open(dbPath: string, clock: TestClock): { gw: Gateway; adapter: FakeAdapter } {
  const adapter = createFakeAdapter();
  const { gateway } = openGateway({ dbPath, clock, routes: [ROUTE], adapter });
  return { gw: gateway, adapter };
}

// A second gateway with its own Store connection on the same ledger, standing in for another process.
// busy_timeout 0 makes a request that meets the writer lock fail at once rather than block this single
// thread; a real process would wait and then run after the commit.
function openOtherWriter(dbPath: string, clock: TestClock): Gateway {
  const { gw } = open(dbPath, clock);
  gw.store.db.exec("PRAGMA busy_timeout = 0");
  return gw;
}

type Attempt = { outcome: "committed"; response: ReturnType<Gateway["handleRequest"]> } | { outcome: "busy" };

function tryRequest(other: Gateway, method: string, body: unknown, requestId: string): Attempt {
  try {
    return { outcome: "committed", response: handle(other, method, body, other.clock.nowMs(), requestId) };
  } catch (err) {
    if (((err as { errcode?: number }).errcode ?? 0) % 256 === SQLITE_BUSY) return { outcome: "busy" };
    throw err;
  }
}

// Runs `race` once, right after the first call of `method` on `store` that `when` selects.
function raceAfter<K extends "getJob" | "getRequest">(
  t: TestContext,
  store: Store,
  method: K,
  when: (args: unknown[]) => boolean,
  race: () => Attempt,
): Attempt[] {
  const attempts: Attempt[] = [];
  const original = (store[method] as (...args: unknown[]) => unknown).bind(store);
  t.mock.method(store, method, (...args: unknown[]) => {
    const result = original(...args);
    if (attempts.length === 0 && when(args)) attempts.push(race());
    return result;
  });
  return attempts;
}

function createJob(gw: Gateway, requestId?: string): string {
  const res = handle(gw, "job.create", CREATE_BODY, gw.clock.nowMs(), requestId);
  assert.equal(res.ok, true);
  return (res as { body: { jobId: string } }).body.jobId;
}

function auditCount(gw: Gateway, kind: string): number {
  return gw.store.listAudit().filter((a) => a.kind === kind).length;
}

// Ticks at the scheduled instant and once more after it, returning how many sends this gateway made.
function tickPastSchedule(gw: Gateway, adapter: FakeAdapter, clock: TestClock): number {
  clock.set(Date.parse(AT));
  gw.tick();
  clock.add(60_000);
  gw.tick();
  return adapter.sent.length;
}

for (const mutation of [
  { method: "job.resume", from: "paused", to: "active" },
  { method: "job.pause", from: "active", to: "paused" },
]) {
  test(`${mutation.method} that has read the job ${mutation.from} holds the writer lock; a second-Store cancel waits behind it and ends cancelled with no send`, (t) => {
    const dir = tmpDir();
    const dbPath = join(dir, "gateway.sqlite");
    const clock = new TestClock(START_MS);
    const { gw, adapter } = open(dbPath, clock);
    const other = openOtherWriter(dbPath, clock);
    const jobId = createJob(gw);
    if (mutation.from === "paused") assert.equal(handle(gw, "job.pause", { jobId }, clock.nowMs()).ok, true);

    const attempts = raceAfter(t, gw.store, "getJob", (args) => args[0] === jobId, () =>
      tryRequest(other, "job.cancel", { jobId }, "race-cancel"),
    );
    const mutated = handle(gw, mutation.method, { jobId }, clock.nowMs(), "race-mutation");
    t.mock.restoreAll();
    if (attempts[0]?.outcome === "committed") {
      assert.equal(gw.store.getJob(jobId)?.status, "cancelled", "a committed cancel is never overwritten");
    }
    assert.deepEqual(attempts, [{ outcome: "busy" }], "the cancel cannot commit between the status read and write");
    assert.deepEqual(mutated, { ok: true, requestId: "race-mutation", body: { jobId, status: mutation.to } });
    assert.equal(gw.store.getJob(jobId)?.status, mutation.to);

    // The waiting cancel runs after the commit and wins the final status.
    const retried = tryRequest(other, "job.cancel", { jobId }, "race-cancel");
    assert.equal(retried.outcome, "committed");
    assert.equal(gw.store.getJob(jobId)?.status, "cancelled");
    assert.equal(tickPastSchedule(gw, adapter, clock), 0);
    other.close();
    gw.close();

    const { gw: reopened, adapter: fresh } = open(dbPath, clock);
    try {
      assert.equal(tickPastSchedule(reopened, fresh, clock), 0);
      assert.equal(reopened.store.getJob(jobId)?.status, "cancelled");
      assert.equal(auditCount(reopened, "job.cancelled"), 1);
      assert.equal(auditCount(reopened, `job.${mutation.to}`), 1);
    } finally {
      reopened.close();
    }
    cleanup(dir);
  });

  test(`${mutation.method} whose dedup read precedes a committed second-Store cancel is denied under the writer lock and never sends`, (t) => {
    const dir = tmpDir();
    const dbPath = join(dir, "gateway.sqlite");
    const clock = new TestClock(START_MS);
    const { gw, adapter } = open(dbPath, clock);
    const other = openOtherWriter(dbPath, clock);
    const jobId = createJob(gw);
    if (mutation.from === "paused") assert.equal(handle(gw, "job.pause", { jobId }, clock.nowMs()).ok, true);

    const attempts = raceAfter(t, gw.store, "getRequest", (args) => args[0] === "race-mutation" && !gw.store.db.isTransaction, () =>
      tryRequest(other, "job.cancel", { jobId }, "race-cancel"),
    );
    const mutated = handle(gw, mutation.method, { jobId }, clock.nowMs(), "race-mutation");
    t.mock.restoreAll();
    assert.equal(attempts[0]?.outcome, "committed");
    assert.deepEqual(mutated, {
      ok: false,
      requestId: "race-mutation",
      error: { code: "invalid_body", message: "job is cancelled" },
    });
    assert.equal(gw.store.getJob(jobId)?.status, "cancelled");
    assert.equal(auditCount(gw, `job.${mutation.to}`), 0);
    assert.equal(tickPastSchedule(gw, adapter, clock), 0);
    other.close();
    gw.close();
    cleanup(dir);
  });

  test(`${mutation.method} whose audit write fails leaves the job ${mutation.from} with no request log or audit; the retry succeeds once`, () => {
    const dir = tmpDir();
    const dbPath = join(dir, "gateway.sqlite");
    const clock = new TestClock(START_MS);
    const { gw, adapter } = open(dbPath, clock);
    const jobId = createJob(gw);
    if (mutation.from === "paused") assert.equal(handle(gw, "job.pause", { jobId }, clock.nowMs()).ok, true);
    const statusAudits = auditCount(gw, `job.${mutation.to}`);

    const side = new DatabaseSync(dbPath);
    side.exec(
      `CREATE TRIGGER block_audit BEFORE INSERT ON audit WHEN NEW.kind = 'job.${mutation.to}' BEGIN SELECT RAISE(ABORT, 'injected audit failure'); END`,
    );
    assert.throws(() => handle(gw, mutation.method, { jobId }, clock.nowMs(), "faulted"), /injected audit failure/);
    assert.equal(gw.store.getJob(jobId)?.status, mutation.from);
    assert.equal(gw.store.getRequest("faulted"), null);
    assert.equal(auditCount(gw, `job.${mutation.to}`), statusAudits);
    assert.equal(tickPastSchedule(gw, adapter, clock), mutation.from === "active" ? 1 : 0, "only the unchanged status governs the tick");
    side.exec("DROP TRIGGER block_audit");
    side.close();

    const first = handle(gw, mutation.method, { jobId }, clock.nowMs(), "faulted");
    const again = handle(gw, mutation.method, { jobId }, clock.nowMs(), "faulted");
    assert.deepEqual(first, { ok: true, requestId: "faulted", body: { jobId, status: mutation.to } });
    assert.deepEqual(again, first);
    assert.equal(auditCount(gw, `job.${mutation.to}`), statusAudits + 1);
    gw.tick();
    assert.equal(adapter.sent.length, 1, "the once job sends exactly once, before the pause or after the resume");
    gw.close();

    const { gw: reopened, adapter: fresh } = open(dbPath, clock);
    try {
      assert.equal(tickPastSchedule(reopened, fresh, clock), 0);
      assert.equal(reopened.store.getJob(jobId)?.status, mutation.to);
      assert.equal(reopened.store.listDeliveries().length, 1);
    } finally {
      reopened.close();
    }
    cleanup(dir);
  });
}

test("job.pause and job.resume keep the pending-approval guard under the writer lock and record the denial", () => {
  const dir = tmpDir();
  const dbPath = join(dir, "gateway.sqlite");
  const clock = new TestClock(START_MS);
  const { gw } = open(dbPath, clock);
  const res = handle(gw, "job.create", { ...CREATE_BODY, requireApproval: true }, clock.nowMs());
  assert.equal(res.ok, true);
  const jobId = (res as { body: { jobId: string } }).body.jobId;
  for (const method of ["job.pause", "job.resume"]) {
    const denied = handle(gw, method, { jobId }, clock.nowMs(), `${method}-pending`);
    assert.deepEqual(denied, {
      ok: false,
      requestId: `${method}-pending`,
      error: { code: "invalid_body", message: "job is pending approval" },
    });
    assert.equal(gw.store.getRequest(`${method}-pending`), JSON.stringify(denied));
  }
  assert.equal(gw.store.getJob(jobId)?.status, "pending-approval");
  gw.close();
  cleanup(dir);
});

test("job.create with the same requestId from two Stores after both miss the dedup read creates one job and sends once across reopen", (t) => {
  const dir = tmpDir();
  const dbPath = join(dir, "gateway.sqlite");
  const clock = new TestClock(START_MS);
  const { gw, adapter } = open(dbPath, clock);
  const other = openOtherWriter(dbPath, clock);

  const attempts = raceAfter(t, gw.store, "getRequest", (args) => args[0] === "same-create" && !gw.store.db.isTransaction, () =>
    tryRequest(other, "job.create", CREATE_BODY, "same-create"),
  );
  const created = handle(gw, "job.create", CREATE_BODY, clock.nowMs(), "same-create");
  t.mock.restoreAll();
  const raced = attempts[0];
  assert.equal(raced?.outcome, "committed");
  assert.equal(created.ok, true);
  assert.deepEqual(created, (raced as { response: unknown }).response, "both callers get the committed response");
  const jobId = (created as { body: { jobId: string } }).body.jobId;
  assert.deepEqual(gw.store.listJobs().map((j) => j.job_id), [jobId]);
  assert.equal(auditCount(gw, "job.create"), 1);
  assert.equal(auditCount(gw, "job.create.attempt"), 1);
  assert.equal(tickPastSchedule(gw, adapter, clock), 1);
  other.close();
  gw.close();

  const { gw: reopened, adapter: fresh } = open(dbPath, clock);
  try {
    assert.equal(tickPastSchedule(reopened, fresh, clock), 0);
    assert.equal(reopened.store.listJobs().length, 1);
    assert.equal(reopened.store.listOccurrences().length, 1);
    assert.equal(reopened.store.listDeliveries().length, 1);
  } finally {
    reopened.close();
  }
  cleanup(dir);
});

test("job.create whose audit write fails rolls back the job, attempt audit and request log; the retry creates one job that sends once", () => {
  const dir = tmpDir();
  const dbPath = join(dir, "gateway.sqlite");
  const clock = new TestClock(START_MS);
  const { gw, adapter } = open(dbPath, clock);

  const side = new DatabaseSync(dbPath);
  side.exec("CREATE TRIGGER block_audit BEFORE INSERT ON audit WHEN NEW.kind = 'job.create' BEGIN SELECT RAISE(ABORT, 'injected audit failure'); END");
  assert.throws(() => handle(gw, "job.create", CREATE_BODY, clock.nowMs(), "faulted-create"), /injected audit failure/);
  assert.deepEqual(gw.store.listJobs(), []);
  assert.equal(gw.store.getRequest("faulted-create"), null);
  assert.equal(auditCount(gw, "job.create.attempt"), 0);
  side.exec("DROP TRIGGER block_audit");
  side.close();

  const jobId = createJob(gw, "faulted-create");
  assert.equal(createJob(gw, "faulted-create"), jobId);
  assert.deepEqual(gw.store.listJobs().map((j) => j.job_id), [jobId]);
  assert.equal(tickPastSchedule(gw, adapter, clock), 1);
  gw.close();

  const { gw: reopened, adapter: fresh } = open(dbPath, clock);
  try {
    assert.equal(tickPastSchedule(reopened, fresh, clock), 0);
    assert.equal(reopened.store.listOccurrences().length, 1);
  } finally {
    reopened.close();
  }
  cleanup(dir);
});
