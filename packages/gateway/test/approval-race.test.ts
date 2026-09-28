import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { approvePending, Store, type ApproveResult } from "../dist/index.js";
import { cleanup, handle, openTestGw, ROUTE } from "./helpers.ts";

const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
const indexUrl = new URL("../dist/index.js", import.meta.url).href;
const AT = "2026-01-01T12:00:00.000Z";
const PAUSE_MS = 300;

// A second thread with its own Store connection. It raises flag[0] at the race point, then
// pauses PAUSE_MS: "approve" pauses right after approvePending reads the row, "cancel-job" and
// "quarantine" pause inside their own BEGIN IMMEDIATE transaction before committing.
const RACER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
import(workerData.indexUrl).then(({ Store, approvePending }) => {
  const flag = new Int32Array(workerData.flag);
  const pause = () => {
    Atomics.store(flag, 0, 1);
    Atomics.notify(flag, 0);
    Atomics.wait(flag, 0, 1, workerData.pauseMs);
  };
  const store = new Store(workerData.dbPath);
  try {
    let result = null;
    if (workerData.action === "approve") {
      const read = store[workerData.getter].bind(store);
      store[workerData.getter] = (id) => {
        const row = read(id);
        pause();
        return row;
      };
      result = approvePending(store, workerData.id, workerData.nowMs);
    } else if (workerData.action === "cancel-job") {
      store.transaction(() => {
        store.setJobStatus(workerData.id, "cancelled");
        store.insertAudit(workerData.nowMs, "job.cancelled", { jobId: workerData.id });
        pause();
      });
    } else {
      store.transaction(() => {
        store.applyRestoreQuarantine(workerData.nowMs - 60000, workerData.nowMs);
        pause();
      });
    }
    parentPort.postMessage({ result });
  } finally {
    store.close();
  }
}).catch((err) => parentPort.postMessage({ error: String((err && err.stack) || err) }));
`;

type RacerAction = "approve" | "cancel-job" | "quarantine";

// Starts the racer and returns once it is paused at its race point.
function startRacer(opts: {
  dbPath: string;
  action: RacerAction;
  id: string;
  nowMs: number;
  getter?: "getJob" | "getDelivery";
}): Promise<{ result: ApproveResult | null }> {
  const flag = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(RACER_SOURCE, {
    eval: true,
    workerData: { ...opts, indexUrl, flag: flag.buffer, pauseMs: PAUSE_MS },
  });
  const message = once(worker, "message") as Promise<[{ result: ApproveResult | null; error?: string }]>;
  const exit = once(worker, "exit");
  const done = Promise.all([message, exit]).then(([[msg]]) => {
    if (msg.error) throw new Error(msg.error);
    return { result: msg.result };
  });
  assert.notEqual(Atomics.wait(flag, 0, 0, 10_000), "timed-out", "racer never reached its race point");
  return done;
}

function createPendingJob(gw: ReturnType<typeof openTestGw>["gw"], nowMs: number): string {
  const created = handle(
    gw,
    "job.create",
    { kind: "static-text", text: "race-job", route: ROUTE, schedule: { type: "once", atUtc: AT }, requireApproval: true },
    nowMs,
  );
  if (!created.ok) throw new Error("create failed");
  return (created.body as { jobId: string }).jobId;
}

function enqueuePendingDelivery(gw: ReturnType<typeof openTestGw>["gw"], nowMs: number): string {
  const enq = handle(
    gw,
    "delivery.enqueue",
    { route: ROUTE, text: "race-delivery", notAfter: nowMs + 60 * 60_000, requireApproval: true },
    nowMs,
  );
  if (!enq.ok) throw new Error("enqueue failed");
  return (enq.body as { deliveryId: string }).deliveryId;
}

function auditKinds(store: Store): string[] {
  return store.listAudit().map((row) => row.kind);
}

test("job approved after its pending read is still cancelled by a second Store and never sends", async () => {
  const { gw, clock, dir, adapter } = openTestGw();
  const jobId = createPendingJob(gw, clock.nowMs());
  const racer = startRacer({ dbPath: gw.store.path, action: "approve", id: jobId, nowMs: clock.nowMs(), getter: "getJob" });

  const cancelled = handle(gw, "job.cancel", { jobId }, clock.nowMs());
  assert.equal(cancelled.ok, true);
  const { result } = await racer;

  assert.deepEqual(result, { ok: true, value: { kind: "job", id: jobId, status: "active" } });
  assert.equal(gw.store.getJob(jobId)?.status, "cancelled");
  const kinds = auditKinds(gw.store);
  assert.ok(kinds.indexOf("job.approved") < kinds.indexOf("job.cancelled"), kinds.join(","));
  clock.set(Date.parse(AT));
  gw.tick();
  gw.processOutbox();
  assert.equal(gw.store.listDeliveries().length, 0);
  assert.equal(adapter.sent.length, 0);
  gw.close();
  cleanup(dir);
});

test("delivery approved after its pending read is still quarantined by a second Store and never sends", async () => {
  const { gw, clock, dir, adapter } = openTestGw();
  const deliveryId = enqueuePendingDelivery(gw, clock.nowMs());
  const racer = startRacer({
    dbPath: gw.store.path,
    action: "approve",
    id: deliveryId,
    nowMs: clock.nowMs(),
    getter: "getDelivery",
  });

  gw.restoreQuarantine(clock.nowMs() - 60_000);
  const { result } = await racer;

  assert.deepEqual(result, { ok: true, value: { kind: "delivery", id: deliveryId, status: "queued" } });
  assert.equal(gw.store.getDelivery(deliveryId)?.status, "commit-unknown");
  const kinds = auditKinds(gw.store);
  assert.ok(kinds.indexOf("delivery.approved") < kinds.indexOf("restore.quarantine"), kinds.join(","));
  gw.resumeDispatch();
  gw.processOutbox();
  assert.equal(adapter.sent.length, 0);
  gw.close();
  cleanup(dir);
});

test("job cancelled by a second Store before approval commits rejects approval without writes", async () => {
  const { gw, clock, dir, adapter } = openTestGw();
  const jobId = createPendingJob(gw, clock.nowMs());
  const racer = startRacer({ dbPath: gw.store.path, action: "cancel-job", id: jobId, nowMs: clock.nowMs() });

  const approved = approvePending(gw.store, jobId, clock.nowMs());
  await racer;

  assert.deepEqual(approved, { ok: false, error: { code: "invalid_body", message: "job is not pending approval" } });
  assert.equal(gw.store.getJob(jobId)?.status, "cancelled");
  assert.deepEqual(auditKinds(gw.store).slice(-1), ["job.cancelled"]);
  assert.equal(auditKinds(gw.store).includes("job.approved"), false);
  clock.set(Date.parse(AT));
  gw.tick();
  gw.processOutbox();
  assert.equal(gw.store.listDeliveries().length, 0);
  assert.equal(adapter.sent.length, 0);
  gw.close();
  cleanup(dir);
});

test("delivery quarantined by a second Store before approval commits rejects approval without writes", async () => {
  const { gw, clock, dir, adapter } = openTestGw();
  const deliveryId = enqueuePendingDelivery(gw, clock.nowMs());
  const auditBefore = gw.store.listAudit().length;
  const racer = startRacer({ dbPath: gw.store.path, action: "quarantine", id: deliveryId, nowMs: clock.nowMs() });

  const approved = approvePending(gw.store, deliveryId, clock.nowMs());
  await racer;

  assert.deepEqual(approved, { ok: false, error: { code: "invalid_body", message: "delivery is not pending approval" } });
  assert.equal(gw.store.getDelivery(deliveryId)?.status, "commit-unknown");
  assert.equal(gw.store.listAudit().length, auditBefore);
  gw.resumeDispatch();
  gw.processOutbox();
  assert.equal(adapter.sent.length, 0);
  gw.close();
  cleanup(dir);
});

test("approval audit failure rolls back the job and delivery status change", () => {
  const { gw, clock, dir } = openTestGw();
  const jobId = createPendingJob(gw, clock.nowMs());
  const deliveryId = enqueuePendingDelivery(gw, clock.nowMs());
  gw.store.db.exec(
    "CREATE TEMP TRIGGER reject_approval_audit BEFORE INSERT ON audit WHEN NEW.kind LIKE '%.approved' BEGIN SELECT RAISE(ABORT, 'audit rejected'); END",
  );

  assert.throws(() => gw.approve(jobId), /audit rejected/);
  assert.throws(() => gw.approve(deliveryId), /audit rejected/);
  assert.equal(gw.store.getJob(jobId)?.status, "pending-approval");
  assert.equal(gw.store.getDelivery(deliveryId)?.status, "pending-approval");

  gw.store.db.exec("DROP TRIGGER reject_approval_audit");
  assert.equal(gw.approve(jobId).ok, true);
  assert.equal(gw.approve(deliveryId).ok, true);
  assert.equal(gw.store.getJob(jobId)?.status, "active");
  assert.equal(gw.store.getDelivery(deliveryId)?.status, "queued");
  gw.close();
  cleanup(dir);
});

test("CLI approve waits for a concurrent cancellation and then refuses the cancelled job", async () => {
  const { gw, clock, dir } = openTestGw();
  const jobId = createPendingJob(gw, clock.nowMs());
  const dbPath = gw.store.path;
  gw.close();
  chmodSync(dir, 0o700);

  const canceller = new Store(dbPath);
  canceller.db.exec("BEGIN IMMEDIATE");
  canceller.setJobStatus(jobId, "cancelled");
  canceller.insertAudit(clock.nowMs(), "job.cancelled", { jobId });
  const cli = spawn(process.execPath, [cliPath, "--profile", dir, "approve", jobId], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  cli.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exited = once(cli, "exit") as Promise<[number | null]>;
  await sleep(1_500);
  assert.equal(cli.exitCode, null, "CLI finished while the cancellation held the write lock");
  canceller.db.exec("COMMIT");
  canceller.close();
  const [code] = await exited;

  assert.equal(code, 1, stderr);
  assert.match(stderr, /job is not pending approval/);
  const { gw: gw2, clock: clock2, adapter } = openTestGw({ dir });
  assert.equal(gw2.store.getJob(jobId)?.status, "cancelled");
  assert.equal(auditKinds(gw2.store).includes("job.approved"), false);
  clock2.set(Date.parse(AT));
  gw2.tick();
  gw2.processOutbox();
  assert.equal(adapter.sent.length, 0);
  gw2.close();
  cleanup(dir);
});
