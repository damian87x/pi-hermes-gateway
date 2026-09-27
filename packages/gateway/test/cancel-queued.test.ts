import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { PROTOCOL_VERSION } from "pi-hermes-gateway-protocol";
import { createFakeAdapter, openGateway, sendIpc, TestClock, type Gateway, type SendAdapter } from "../dist/index.js";
import { listenIpc } from "../dist/ipc.js";
import { cleanup, collectUnhandledRejections, deferred, flushAsync, handle, ROUTE, tmpDir } from "./helpers.ts";

type Receipt = { receiptLevel: "accepted"; providerMessageId: string };

const START_MS = Date.UTC(2026, 0, 1, 10, 0, 0);
const AT_UTC = "2026-01-01T10:01:00.000Z";

// The first send is held on a deferred receipt; later sends settle accepted at once.
function holdingAdapter() {
  const holder = deferred<Receipt>();
  const sent: string[] = [];
  const adapter: SendAdapter = {
    manifest: createFakeAdapter().manifest,
    send(envelope) {
      sent.push(envelope.text);
      if (sent.length === 1) return holder.promise;
      return { receiptLevel: "accepted", providerMessageId: `p:${envelope.deliveryId}` };
    },
  };
  return { adapter, holder, sent };
}

function open(dbPath: string, clock: TestClock, adapter: SendAdapter, notAfterBoundMs?: number): Gateway {
  return openGateway({ dbPath, clock, routes: [ROUTE], adapter, notAfterBoundMs }).gateway;
}

function createOnceJob(gw: Gateway, text: string): string {
  const res = handle(gw, "job.create", { kind: "static-text", text, route: ROUTE, schedule: { type: "once", atUtc: AT_UTC } }, gw.clock.nowMs());
  assert.equal(res.ok, true);
  return (res as { body: { jobId: string } }).body.jobId;
}

// Holds the outbox on an async enqueue send, then ticks the job due so its delivery stays queued.
function holdOutboxWithQueuedJobDelivery(gw: Gateway, clock: TestClock, jobId: string) {
  const enq = handle(gw, "delivery.enqueue", { route: ROUTE, text: "holder", notAfter: clock.nowMs() + 3_600_000 }, clock.nowMs());
  assert.equal((enq as { body: { status: string } }).body.status, "dispatching");
  clock.set(Date.parse(AT_UTC));
  gw.tick();
  const [occ] = gw.store.listOccurrences(jobId);
  const jobRow = gw.store.listDeliveries().find((d) => d.job_id === jobId);
  assert.equal(occ?.status, "pending");
  assert.equal(jobRow?.status, "queued");
  return { holderId: (enq as { body: { deliveryId: string } }).body.deliveryId, occurrenceId: occ.occurrence_id, jobDeliveryId: jobRow.delivery_id };
}

function wireRequest(method: string, body: unknown, nowMs: number, requestId: string) {
  return { protocolVersion: PROTOCOL_VERSION, requestId, method, body, expiresAt: nowMs + 30_000 };
}

test("IPC job.cancel while an async send holds the outbox fails the queued job delivery; settling the holder and restarting never send it", async () => {
  const dir = tmpDir();
  const dbPath = join(dir, "gateway.sqlite");
  const clock = new TestClock(START_MS);
  const { adapter, holder, sent } = holdingAdapter();
  const unhandled = await collectUnhandledRejections(async () => {
    const gw = open(dbPath, clock, adapter);
    const sock = join(dir, "gw.sock");
    const server = listenIpc(sock, gw);
    try {
      const jobId = createOnceJob(gw, "cancelled-job");
      const { holderId, occurrenceId, jobDeliveryId } = holdOutboxWithQueuedJobDelivery(gw, clock, jobId);

      const cancelled = await sendIpc(sock, wireRequest("job.cancel", { jobId }, clock.nowMs(), "cancel-ipc-1"));
      assert.deepEqual((cancelled as { ok: boolean; body: unknown }).body, { jobId, status: "cancelled" });
      assert.equal(gw.store.getJob(jobId)?.status, "cancelled");
      assert.equal(gw.store.getDelivery(jobDeliveryId)?.status, "failed");
      assert.equal(gw.store.getDelivery(jobDeliveryId)?.dispatch_intent, 0);
      assert.equal(gw.store.getOccurrence(occurrenceId)?.status, "skipped");
      const cancelAudit = gw.store.listAudit().find((a) => a.kind === "delivery.cancelled");
      assert.deepEqual(JSON.parse(cancelAudit?.payload_json ?? "null"), { deliveryId: jobDeliveryId, jobId, occurrenceId });

      holder.resolve({ receiptLevel: "accepted", providerMessageId: "p:holder" });
      await flushAsync();
      assert.equal(gw.store.getDelivery(holderId)?.status, "accepted");
      gw.tick();
      assert.deepEqual(sent, ["holder"]);
      assert.equal(gw.store.getDelivery(jobDeliveryId)?.status, "failed");
    } finally {
      server.close();
      gw.close();
    }

    const fresh = createFakeAdapter();
    const reopened = open(dbPath, clock, fresh);
    try {
      reopened.tick();
      clock.add(60_000);
      reopened.tick();
      assert.equal(fresh.sent.length, 0);
    } finally {
      reopened.close();
    }
  });
  assert.deepEqual(unhandled, []);
  cleanup(dir);
});

test("job.cancel after the holder's receipt write halts the outbox fails the queued job delivery; restart does not send it", async () => {
  const dir = tmpDir();
  const dbPath = join(dir, "gateway.sqlite");
  const clock = new TestClock(START_MS);
  const { adapter, holder, sent } = holdingAdapter();
  const unhandled = await collectUnhandledRejections(async () => {
    const gw = open(dbPath, clock, adapter);
    const side = new DatabaseSync(dbPath);
    let jobDeliveryId = "";
    try {
      const jobId = createOnceJob(gw, "halted-job");
      ({ jobDeliveryId } = holdOutboxWithQueuedJobDelivery(gw, clock, jobId));
      side.exec(
        "CREATE TRIGGER block_accepted BEFORE UPDATE OF status ON deliveries WHEN NEW.status = 'accepted' " +
          "BEGIN SELECT RAISE(ABORT, 'injected accepted write failure'); END",
      );
      holder.resolve({ receiptLevel: "accepted", providerMessageId: "p:holder" });
      await flushAsync();
      assert.ok(gw.outboxHalt);
      side.exec("DROP TRIGGER block_accepted");

      const cancelled = handle(gw, "job.cancel", { jobId }, clock.nowMs());
      assert.equal(cancelled.ok, true);
      assert.equal(gw.store.getDelivery(jobDeliveryId)?.status, "failed");
    } finally {
      side.close();
      gw.close();
    }

    const fresh = createFakeAdapter();
    const reopened = open(dbPath, clock, fresh);
    try {
      reopened.tick();
      assert.equal(fresh.sent.length, 0);
      assert.equal(reopened.store.getDelivery(jobDeliveryId)?.status, "failed");
    } finally {
      reopened.close();
    }
    assert.deepEqual(sent, ["holder"]);
  });
  assert.deepEqual(unhandled, []);
  cleanup(dir);
});

test("job.pause keeps an unsent queued job delivery queued across a restart; resume dispatches it once", async () => {
  const dir = tmpDir();
  const dbPath = join(dir, "gateway.sqlite");
  const clock = new TestClock(START_MS);
  const { adapter, holder, sent } = holdingAdapter();
  const unhandled = await collectUnhandledRejections(async () => {
    const gw = open(dbPath, clock, adapter);
    let jobId = "";
    let occurrenceId = "";
    let jobDeliveryId = "";
    try {
      jobId = createOnceJob(gw, "paused-job");
      ({ occurrenceId, jobDeliveryId } = holdOutboxWithQueuedJobDelivery(gw, clock, jobId));
      const paused = handle(gw, "job.pause", { jobId }, clock.nowMs());
      assert.equal(paused.ok, true);
      holder.resolve({ receiptLevel: "accepted", providerMessageId: "p:holder" });
      await flushAsync();
      gw.tick();
      assert.deepEqual(sent, ["holder"]);
      assert.equal(gw.store.getDelivery(jobDeliveryId)?.status, "queued");
      assert.equal(gw.store.getDelivery(jobDeliveryId)?.dispatch_intent, 0);
      assert.equal(gw.store.getOccurrence(occurrenceId)?.status, "pending");
      assert.equal(gw.store.listAudit().some((a) => a.kind === "delivery.send.attempt" && a.payload_json.includes(jobDeliveryId)), false);
    } finally {
      gw.close();
    }

    const fresh = createFakeAdapter();
    const reopened = open(dbPath, clock, fresh);
    try {
      reopened.tick();
      assert.equal(fresh.sent.length, 0);
      assert.equal(reopened.store.getDelivery(jobDeliveryId)?.status, "queued");
      const resumed = handle(reopened, "job.resume", { jobId }, clock.nowMs());
      assert.equal(resumed.ok, true);
      reopened.tick();
      reopened.tick();
      assert.deepEqual(fresh.sent.map((e) => e.text), ["paused-job"]);
      assert.equal(reopened.store.getDelivery(jobDeliveryId)?.status, "accepted");
      assert.equal(reopened.store.getOccurrence(occurrenceId)?.status, "completed");
    } finally {
      reopened.close();
    }
  });
  assert.deepEqual(unhandled, []);
  cleanup(dir);
});

test("a paused job's queued delivery that passes its notAfter while paused expires on resume without sending", async () => {
  const dir = tmpDir();
  const dbPath = join(dir, "gateway.sqlite");
  const clock = new TestClock(START_MS);
  const { adapter, holder, sent } = holdingAdapter();
  const unhandled = await collectUnhandledRejections(async () => {
    const gw = open(dbPath, clock, adapter, 60_000);
    try {
      const jobId = createOnceJob(gw, "stale-job");
      const { occurrenceId, jobDeliveryId } = holdOutboxWithQueuedJobDelivery(gw, clock, jobId);
      assert.equal(handle(gw, "job.pause", { jobId }, clock.nowMs()).ok, true);
      holder.resolve({ receiptLevel: "accepted", providerMessageId: "p:holder" });
      await flushAsync();
      clock.add(120_000);
      assert.equal(handle(gw, "job.resume", { jobId }, clock.nowMs()).ok, true);
      gw.tick();
      assert.deepEqual(sent, ["holder"]);
      assert.equal(gw.store.getDelivery(jobDeliveryId)?.status, "expired");
      assert.equal(gw.store.getOccurrence(occurrenceId)?.status, "expired");
    } finally {
      gw.close();
    }
  });
  assert.deepEqual(unhandled, []);
  cleanup(dir);
});

test("job.cancel leaves an already-dispatching job delivery in flight; its accepted receipt is recorded", async () => {
  const dir = tmpDir();
  const dbPath = join(dir, "gateway.sqlite");
  const clock = new TestClock(START_MS);
  const { adapter, holder, sent } = holdingAdapter();
  const unhandled = await collectUnhandledRejections(async () => {
    const gw = open(dbPath, clock, adapter);
    try {
      const jobId = createOnceJob(gw, "in-flight-job");
      clock.set(Date.parse(AT_UTC));
      gw.tick();
      const row = gw.store.listDeliveries().find((d) => d.job_id === jobId);
      assert.equal(row?.status, "dispatching");
      const cancelled = handle(gw, "job.cancel", { jobId }, clock.nowMs());
      assert.equal(cancelled.ok, true);
      assert.equal(gw.store.getDelivery(row.delivery_id)?.status, "dispatching");
      assert.equal(gw.store.listAudit().some((a) => a.kind === "delivery.cancelled"), false);
      holder.resolve({ receiptLevel: "accepted", providerMessageId: "p:in-flight" });
      await flushAsync();
      assert.deepEqual(sent, ["in-flight-job"]);
      assert.equal(gw.store.getDelivery(row.delivery_id)?.status, "accepted");
      assert.equal(gw.store.getOccurrence(row.occurrence_id ?? "")?.status, "completed");
      assert.equal(gw.store.getJob(jobId)?.status, "cancelled");
    } finally {
      gw.close();
    }
  });
  assert.deepEqual(unhandled, []);
  cleanup(dir);
});

for (const fault of [
  { name: "delivery failed write", trigger: "BEFORE UPDATE OF status ON deliveries WHEN NEW.status = 'failed'" },
  { name: "occurrence skipped write", trigger: "BEFORE UPDATE OF status ON occurrences WHEN NEW.status = 'skipped'" },
  { name: "job.cancelled audit", trigger: "BEFORE INSERT ON audit WHEN NEW.kind = 'job.cancelled'" },
  { name: "request_log write", trigger: "BEFORE INSERT ON request_log" },
]) {
  test(`job.cancel whose ${fault.name} fails rolls back whole and answers an error; the retry cancels`, async () => {
    const dir = tmpDir();
    const dbPath = join(dir, "gateway.sqlite");
    const clock = new TestClock(START_MS);
    const adapter = createFakeAdapter();
    const gw = open(dbPath, clock, adapter);
    const sock = join(dir, "gw.sock");
    const server = listenIpc(sock, gw);
    const side = new DatabaseSync(dbPath);
    try {
      const jobId = createOnceJob(gw, "fault-job");
      gw.store.setMeta("dispatch_enabled", "0");
      clock.set(Date.parse(AT_UTC));
      gw.tick();
      const [row] = gw.store.listDeliveries();
      assert.equal(row?.status, "queued");
      const auditBefore = gw.store.listAudit().length;

      side.exec(`CREATE TRIGGER block_cancel ${fault.trigger} BEGIN SELECT RAISE(ABORT, 'injected cancel write failure'); END`);
      const failed = await sendIpc(sock, wireRequest("job.cancel", { jobId }, clock.nowMs(), "cancel-fault-1"));
      assert.equal((failed as { ok: boolean }).ok, false);
      assert.equal((failed as { error: { code: string } }).error.code, "internal");
      assert.equal(gw.store.getJob(jobId)?.status, "active");
      assert.equal(gw.store.getDelivery(row.delivery_id)?.status, "queued");
      assert.equal(gw.store.getOccurrence(row.occurrence_id ?? "")?.status, "pending");
      assert.equal(gw.store.listAudit().length, auditBefore);
      assert.equal(gw.store.getRequest("cancel-fault-1"), null);
      side.exec("DROP TRIGGER block_cancel");

      const retried = await sendIpc(sock, wireRequest("job.cancel", { jobId }, clock.nowMs(), "cancel-fault-1"));
      assert.deepEqual((retried as { body: unknown }).body, { jobId, status: "cancelled" });
      assert.equal(gw.store.getDelivery(row.delivery_id)?.status, "failed");
      assert.equal(gw.store.getOccurrence(row.occurrence_id ?? "")?.status, "skipped");
      gw.store.setMeta("dispatch_enabled", "1");
      gw.tick();
      assert.equal(adapter.sent.length, 0);
    } finally {
      side.close();
      server.close();
      gw.close();
    }
    cleanup(dir);
  });
}

test("a cancelled job's leftover queued delivery never dispatches and cannot be resumed into active", () => {
  const dir = tmpDir();
  const clock = new TestClock(START_MS);
  const adapter = createFakeAdapter();
  const gw = open(join(dir, "gateway.sqlite"), clock, adapter);
  try {
    const jobId = createOnceJob(gw, "leftover-job");
    gw.store.setMeta("dispatch_enabled", "0");
    clock.set(Date.parse(AT_UTC));
    gw.tick();
    const [row] = gw.store.listDeliveries();
    // A ledger cancelled before cancel failed its queued rows.
    gw.store.setJobStatus(jobId, "cancelled");
    gw.store.setMeta("dispatch_enabled", "1");
    gw.tick();
    assert.equal(handle(gw, "job.resume", { jobId }, clock.nowMs()).ok, false);
    assert.equal(handle(gw, "job.pause", { jobId }, clock.nowMs()).ok, false);
    gw.tick();
    assert.equal(adapter.sent.length, 0);
    assert.equal(gw.store.getDelivery(row?.delivery_id ?? "")?.status, "queued");
    assert.equal(gw.store.getDelivery(row?.delivery_id ?? "")?.dispatch_intent, 0);
  } finally {
    gw.close();
  }
  cleanup(dir);
});

test("a job cancelled by another writer after the dispatch recheck is refused at the dispatch intent", () => {
  const dir = tmpDir();
  const dbPath = join(dir, "gateway.sqlite");
  const clock = new TestClock(START_MS);
  const adapter = createFakeAdapter();
  const gw = open(dbPath, clock, adapter);
  const side = new DatabaseSync(dbPath);
  try {
    const jobId = createOnceJob(gw, "raced-job");
    // Lands the other writer's cancel between the owning-job recheck and the intent write.
    side.exec(
      "CREATE TRIGGER race_cancel AFTER INSERT ON audit WHEN NEW.kind = 'delivery.send.attempt' " +
        "BEGIN UPDATE jobs SET status = 'cancelled'; END",
    );
    clock.set(Date.parse(AT_UTC));
    gw.tick();
    const [row] = gw.store.listDeliveries();
    assert.equal(gw.store.getJob(jobId)?.status, "cancelled");
    assert.equal(adapter.sent.length, 0);
    assert.equal(row?.status, "queued");
    assert.equal(row?.dispatch_intent, 0);
  } finally {
    side.close();
    gw.close();
  }
  cleanup(dir);
});
