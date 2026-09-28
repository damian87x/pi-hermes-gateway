import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import {
  createFakeAdapter,
  openGateway,
  TestClock,
  type Gateway,
  type GatewayResponse,
  type SendAdapter,
  type SendReceipt,
  type Store,
} from "../dist/index.js";
import { cleanup, deferred, flushAsync, handle, ROUTE, tmpDir } from "./helpers.ts";

const START_MS = Date.UTC(2026, 0, 1, 10, 0, 0);
const REQUEST_ID = "same-enqueue";
const ROUTE_KEY = "profile-a/fake/acct-1/chat-1/";
const DAY = "2026-01-01";
const BODY = { route: ROUTE, text: "raced", notAfter: START_MS + 60_000 };
const JOB_BODY = {
  kind: "static-text",
  text: "raced",
  route: ROUTE,
  schedule: { type: "daily", localTime: "10:05", timeZone: "UTC" },
};

type Fuses = { capacity?: number; refillPerMs?: number };

// A counting adapter; `beforeSend` runs inside send, after admission committed and before the receipt.
function countingAdapter(sent: string[], beforeSend?: () => void, receipt?: () => Promise<SendReceipt>): SendAdapter {
  return {
    manifest: createFakeAdapter().manifest,
    send(envelope) {
      beforeSend?.();
      sent.push(envelope.deliveryId);
      return receipt ? receipt() : { receiptLevel: "accepted", providerMessageId: `p:${envelope.deliveryId}` };
    },
  };
}

function open(dbPath: string, clock: TestClock, adapter: SendAdapter, fuses: Fuses = {}): Gateway {
  return openGateway({
    dbPath,
    clock,
    routes: [ROUTE],
    adapter,
    tokenBucketCapacity: fuses.capacity ?? 1,
    tokenBucketRefillPerMs: fuses.refillPerMs ?? 0,
  }).gateway;
}

// A second gateway with its own Store connection on the same ledger, standing in for another process.
// busy_timeout 0 makes any request that meets a held writer lock fail at once instead of blocking.
function openOtherWriter(dbPath: string, clock: TestClock, adapter: SendAdapter, fuses?: Fuses): Gateway {
  const gw = open(dbPath, clock, adapter, fuses);
  gw.store.db.exec("PRAGMA busy_timeout = 0");
  return gw;
}

function enqueue(gw: Gateway, body: object = BODY, requestId = REQUEST_ID): GatewayResponse {
  return handle(gw, "delivery.enqueue", body, gw.clock.nowMs(), requestId);
}

// Stands in for handleRequest's dedup reads taken before another Store committed this requestId: outside
// a transaction they miss; under the writer lock they read the ledger.
function staleDedupReads(t: TestContext, store: Store): void {
  const getRequest = store.getRequest.bind(store);
  const getDeliveryByRequestId = store.getDeliveryByRequestId.bind(store);
  t.mock.method(store, "getRequest", (id: string) => (store.db.isTransaction ? getRequest(id) : null));
  t.mock.method(store, "getDeliveryByRequestId", (id: string) =>
    store.db.isTransaction ? getDeliveryByRequestId(id) : undefined,
  );
}

// Runs `before` ahead of, and `after` once, the next transaction on `store` (the enqueue's admission).
function aroundAdmission(t: TestContext, store: Store, hooks: { before?: () => void; after?: () => void }): void {
  const transaction = store.transaction.bind(store);
  let calls = 0;
  t.mock.method(store, "transaction", <T>(fn: () => T): T => {
    calls += 1;
    if (calls === 1) hooks.before?.();
    const result = transaction(fn);
    if (calls === 1) hooks.after?.();
    return result;
  });
}

function ok(deliveryId: string, status: string): GatewayResponse {
  return { ok: true, requestId: REQUEST_ID, body: { deliveryId, status } };
}

function requestDelivery(gw: Gateway) {
  return gw.store.listDeliveries().filter((d) => d.request_id === REQUEST_ID);
}

function auditCount(gw: Gateway, kind: string): number {
  return gw.store.listAudit().filter((a) => a.kind === kind).length;
}

// One row, one token, one daily-cap slot and one admission audit for the raced requestId.
function assertOneAdmission(gw: Gateway, status: string, auditKind: string): string {
  const rows = requestDelivery(gw);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.status, status);
  assert.equal(gw.store.getAccountFuse(ROUTE.accountId)?.tokens, 0, "exactly one token is spent");
  assert.equal(gw.store.getRouteDay(ROUTE_KEY, DAY), 1, "exactly one daily-cap slot is spent");
  assert.equal(auditCount(gw, auditKind), 1);
  return rows[0]!.delivery_id;
}

for (const when of ["before", "during"] as const) {
  test(`an enqueue whose dedup reads predate a second Store's admission, racing ${when} its send, answers that delivery and the owner's accepted response persists`, (t) => {
    const dir = tmpDir();
    const dbPath = join(dir, "gateway.sqlite");
    const clock = new TestClock(START_MS);
    const sent: string[] = [];
    const racer = openOtherWriter(dbPath, clock, countingAdapter(sent));
    const raced: GatewayResponse[] = [];
    const race = () => {
      if (raced.length === 0) raced.push(enqueue(racer));
    };
    const owner = open(dbPath, clock, countingAdapter(sent, when === "during" ? race : undefined));
    staleDedupReads(t, racer.store);
    if (when === "before") aroundAdmission(t, owner.store, { after: race });

    const first = enqueue(owner);
    t.mock.restoreAll();
    const deliveryId = assertOneAdmission(owner, "accepted", "delivery.enqueue");
    assert.deepEqual(raced, [ok(deliveryId, when === "before" ? "queued" : "dispatching")], "the racer is not rate limited");
    assert.deepEqual(first, ok(deliveryId, "accepted"), "the owner still reports its synchronous receipt");
    assert.equal(owner.store.getRequest(REQUEST_ID), JSON.stringify(first), "the racer's in-flight snapshot is replaced");
    assert.deepEqual(enqueue(racer), first);
    assert.deepEqual(enqueue(owner), first);
    assert.deepEqual(sent, [deliveryId]);
    racer.close();
    owner.close();

    const reopened = open(dbPath, clock, countingAdapter(sent));
    assert.deepEqual(enqueue(reopened), first);
    reopened.tick();
    assert.deepEqual(sent, [deliveryId], "restart never resends");
    reopened.close();
    cleanup(dir);
  });
}

for (const order of [
  { name: "admits and sends", burnFirst: false },
  { name: "is rate limited by a genuinely exhausted fuse", burnFirst: true },
]) {
  test(`a same-requestId enqueue that takes the writer lock first and ${order.name} is the answer for a racer whose reads missed it, even after a refill`, (t) => {
    const dir = tmpDir();
    const dbPath = join(dir, "gateway.sqlite");
    const clock = new TestClock(START_MS);
    const sent: string[] = [];
    const fuses = { capacity: 1, refillPerMs: 1 / 60_000 };
    const late = open(dbPath, clock, countingAdapter(sent), fuses);
    const early = openOtherWriter(dbPath, clock, countingAdapter(sent), fuses);
    // Outlives the refill below, so the late admission could otherwise still queue and send.
    const body = { ...BODY, notAfter: START_MS + 3_600_000 };
    if (order.burnFirst) assert.equal(enqueue(late, body, "burn").ok, true);
    const burned = [...sent];

    let earlyResponse: GatewayResponse | null = null;
    aroundAdmission(t, late.store, {
      before: () => {
        earlyResponse = enqueue(early, body);
        clock.add(60_000);
      },
    });
    const lateResponse = enqueue(late, body);
    t.mock.restoreAll();
    assert.ok(earlyResponse);
    assert.deepEqual(lateResponse, earlyResponse, "both callers get the first committed response");
    assert.equal(late.store.getRequest(REQUEST_ID), JSON.stringify(earlyResponse));
    assert.deepEqual(enqueue(late, body), earlyResponse);
    assert.deepEqual(enqueue(early, body), earlyResponse);
    if (order.burnFirst) {
      assert.equal((earlyResponse as { ok: boolean; error?: { code: string } }).error?.code, "rate_limited");
      assert.deepEqual(requestDelivery(late), [], "no delivery is admitted behind the persisted rejection");
      assert.deepEqual(sent, burned);
      assert.equal(auditCount(late, "delivery.enqueue.rejected"), 1);
    } else {
      const deliveryId = requestDelivery(late)[0]?.delivery_id ?? "";
      assert.deepEqual(earlyResponse, ok(deliveryId, "accepted"));
      assert.equal(auditCount(late, "delivery.enqueue"), 1);
      assert.deepEqual(sent, [deliveryId]);
    }
    early.close();
    late.close();
    cleanup(dir);
  });
}

test("an enqueue queued behind an async holder answers a racing Store with its row, persists the owner's response and sends once", async (t) => {
  const dir = tmpDir();
  const dbPath = join(dir, "gateway.sqlite");
  const clock = new TestClock(START_MS);
  const sent: string[] = [];
  const holder = deferred<SendReceipt>();
  let held = false;
  const ownerAdapter = countingAdapter(sent, undefined, () => {
    if (held) return Promise.resolve({ receiptLevel: "accepted" });
    held = true;
    return holder.promise;
  });
  const fuses = { capacity: 2 };
  const owner = open(dbPath, clock, ownerAdapter, fuses);
  const racer = openOtherWriter(dbPath, clock, countingAdapter(sent), fuses);
  const holderResponse = enqueue(owner, { ...BODY, text: "holder" }, "holder");
  assert.equal((holderResponse as { body: { status: string } }).body.status, "dispatching");

  staleDedupReads(t, racer.store);
  const raced: GatewayResponse[] = [];
  aroundAdmission(t, owner.store, { after: () => raced.push(enqueue(racer)) });
  const first = enqueue(owner);
  t.mock.restoreAll();
  const deliveryId = requestDelivery(owner)[0]?.delivery_id ?? "";
  assert.deepEqual(first, ok(deliveryId, "queued"), "the held outbox leaves the owner's row queued");
  assert.deepEqual(raced, [ok(deliveryId, "queued")]);
  assert.equal(owner.store.getRequest(REQUEST_ID), JSON.stringify(first));

  holder.resolve({ receiptLevel: "accepted" });
  await flushAsync();
  assert.equal(owner.store.getDelivery(deliveryId)?.status, "accepted");
  assert.equal(sent.filter((id) => id === deliveryId).length, 1);
  assert.equal(sent.length, 2);
  assert.deepEqual(enqueue(racer), ok(deliveryId, "accepted"), "the replay reports the settled row, not the queued snapshot");
  assert.equal(sent.filter((id) => id === deliveryId).length, 1, "the replay does not re-admit or resend");
  assert.equal(owner.store.getAccountFuse(ROUTE.accountId)?.tokens, 0);
  assert.equal(owner.store.getRouteDay(ROUTE_KEY, DAY), 2);
  racer.close();
  owner.close();
  cleanup(dir);
});

test("a pending-approval enqueue answers a racing Store with its pending response; approval then sends once", (t) => {
  const dir = tmpDir();
  const dbPath = join(dir, "gateway.sqlite");
  const clock = new TestClock(START_MS);
  const sent: string[] = [];
  const owner = open(dbPath, clock, countingAdapter(sent));
  const racer = openOtherWriter(dbPath, clock, countingAdapter(sent));
  const body = { ...BODY, requireApproval: true };
  staleDedupReads(t, racer.store);
  const raced: GatewayResponse[] = [];
  aroundAdmission(t, owner.store, { after: () => raced.push(enqueue(racer, body)) });
  const first = enqueue(owner, body);
  t.mock.restoreAll();
  const deliveryId = assertOneAdmission(owner, "pending-approval", "delivery.enqueue");
  assert.deepEqual(first, ok(deliveryId, "pending-approval"));
  assert.deepEqual(raced, [first]);
  assert.equal(owner.store.getRequest(REQUEST_ID), JSON.stringify(first));

  assert.equal(owner.approve(deliveryId).ok, true);
  owner.tick();
  racer.tick();
  assert.deepEqual(sent, [deliveryId]);
  assert.deepEqual(enqueue(racer, body), ok(deliveryId, "accepted"), "the replay reports the sent row, not re-admitted");
  racer.tick();
  assert.deepEqual(sent, [deliveryId]);
  racer.close();
  owner.close();
  cleanup(dir);
});

test("an enqueue expired at admission answers a racing Store with its expired response and never sends", (t) => {
  const dir = tmpDir();
  const dbPath = join(dir, "gateway.sqlite");
  const ownerClock = new TestClock(START_MS);
  const racerClock = new TestClock(START_MS);
  const sent: string[] = [];
  const owner = open(dbPath, ownerClock, countingAdapter(sent));
  // The racer validated before notAfter; the owner's clock passes it between validation and admission.
  const racer = openOtherWriter(dbPath, racerClock, countingAdapter(sent));
  staleDedupReads(t, racer.store);
  const raced: GatewayResponse[] = [];
  aroundAdmission(t, owner.store, {
    before: () => ownerClock.add(60_000),
    after: () => raced.push(enqueue(racer)),
  });
  const first = enqueue(owner);
  t.mock.restoreAll();
  const deliveryId = assertOneAdmission(owner, "expired", "delivery.expired");
  assert.deepEqual(first, ok(deliveryId, "expired"));
  assert.deepEqual(raced, [first]);
  assert.equal(owner.store.getRequest(REQUEST_ID), JSON.stringify(first));
  assert.deepEqual(enqueue(racer), first);
  owner.tick();
  racer.tick();
  assert.deepEqual(sent, []);
  racer.close();
  owner.close();
  cleanup(dir);
});

for (const fault of [
  {
    name: "pending-approval request_log write",
    trigger: `BEFORE INSERT ON request_log WHEN NEW.request_id = '${REQUEST_ID}'`,
    pending: true,
    burnFirst: false,
  },
  {
    name: "pending-approval admission audit",
    trigger: "BEFORE INSERT ON audit WHEN NEW.kind = 'delivery.enqueue'",
    pending: true,
    burnFirst: false,
  },
  {
    name: "rate-limited request_log write",
    trigger: `BEFORE INSERT ON request_log WHEN NEW.request_id = '${REQUEST_ID}'`,
    pending: false,
    burnFirst: true,
  },
]) {
  test(`an enqueue whose ${fault.name} fails rolls back its row, debit, audit and response; the retry settles once`, () => {
    const dir = tmpDir();
    const dbPath = join(dir, "gateway.sqlite");
    const clock = new TestClock(START_MS);
    const sent: string[] = [];
    const gw = open(dbPath, clock, countingAdapter(sent));
    if (fault.burnFirst) assert.equal(enqueue(gw, BODY, "burn").ok, true);
    const auditsBefore = gw.store.listAudit().filter((a) => a.kind !== "delivery.enqueue.attempt").length;
    const fuseBefore = gw.store.getAccountFuse(ROUTE.accountId);
    const body = { ...BODY, requireApproval: fault.pending };

    const side = new DatabaseSync(dbPath);
    side.exec(`CREATE TRIGGER block_enqueue ${fault.trigger} BEGIN SELECT RAISE(ABORT, 'injected enqueue write failure'); END`);
    assert.throws(() => enqueue(gw, body), /injected enqueue write failure/);
    assert.deepEqual(requestDelivery(gw), []);
    assert.equal(gw.store.getRequest(REQUEST_ID), null);
    assert.deepEqual(gw.store.getAccountFuse(ROUTE.accountId), fuseBefore, "the debit rolls back with the response");
    assert.equal(gw.store.listAudit().filter((a) => a.kind !== "delivery.enqueue.attempt").length, auditsBefore);
    side.exec("DROP TRIGGER block_enqueue");
    side.close();

    const retried = enqueue(gw, body);
    assert.deepEqual(enqueue(gw, body), retried);
    assert.equal(gw.store.getRequest(REQUEST_ID), JSON.stringify(retried));
    if (fault.burnFirst) {
      assert.equal((retried as { ok: boolean; error?: { code: string } }).error?.code, "rate_limited");
      assert.deepEqual(requestDelivery(gw), []);
      assert.equal(auditCount(gw, "delivery.enqueue.rejected"), 1);
    } else {
      const deliveryId = assertOneAdmission(gw, "pending-approval", "delivery.enqueue");
      assert.deepEqual(retried, ok(deliveryId, "pending-approval"));
    }
    assert.equal(sent.length, fault.burnFirst ? 1 : 0);
    gw.close();
    cleanup(dir);
  });
}

test("an enqueue answered dispatching before its async receipt settles is replayed with the accepted status once it does", async () => {
  const dir = tmpDir();
  const dbPath = join(dir, "gateway.sqlite");
  const clock = new TestClock(START_MS);
  const sent: string[] = [];
  const receipt = deferred<SendReceipt>();
  const gw = open(dbPath, clock, countingAdapter(sent, undefined, () => receipt.promise));
  const first = enqueue(gw);
  const deliveryId = requestDelivery(gw)[0]?.delivery_id ?? "";
  assert.deepEqual(first, ok(deliveryId, "dispatching"));
  assert.deepEqual(enqueue(gw), first, "an unsettled send replays dispatching");

  receipt.resolve({ receiptLevel: "accepted" });
  await flushAsync();
  assertOneAdmission(gw, "accepted", "delivery.enqueue");
  assert.deepEqual(enqueue(gw), ok(deliveryId, "accepted"));
  gw.tick();
  assert.deepEqual(sent, [deliveryId]);
  gw.close();

  const reopened = open(dbPath, clock, countingAdapter(sent));
  assert.deepEqual(enqueue(reopened), ok(deliveryId, "accepted"));
  reopened.close();
  cleanup(dir);
});

test("an enqueue answered dispatching whose daemon stops before the receipt is replayed commit-unknown after restart and never resent", () => {
  const dir = tmpDir();
  const dbPath = join(dir, "gateway.sqlite");
  const clock = new TestClock(START_MS);
  const sent: string[] = [];
  const gw = open(dbPath, clock, countingAdapter(sent, undefined, () => deferred<SendReceipt>().promise));
  const first = enqueue(gw);
  const deliveryId = requestDelivery(gw)[0]?.delivery_id ?? "";
  assert.deepEqual(first, ok(deliveryId, "dispatching"));
  gw.close();

  const reopened = open(dbPath, clock, countingAdapter(sent));
  assertOneAdmission(reopened, "commit-unknown", "delivery.enqueue");
  assert.deepEqual(enqueue(reopened), ok(deliveryId, "commit-unknown"));
  reopened.tick();
  assert.deepEqual(enqueue(reopened), ok(deliveryId, "commit-unknown"));
  assert.deepEqual(sent, [deliveryId], "the uncertain send is not replayed");
  reopened.close();
  cleanup(dir);
});

test("an enqueue whose post-send request_log write fails keeps its one send; the retry answers the accepted row", () => {
  const dir = tmpDir();
  const dbPath = join(dir, "gateway.sqlite");
  const clock = new TestClock(START_MS);
  const sent: string[] = [];
  const gw = open(dbPath, clock, countingAdapter(sent));
  const side = new DatabaseSync(dbPath);
  side.exec(
    "CREATE TRIGGER block_log BEFORE INSERT ON request_log BEGIN SELECT RAISE(ABORT, 'injected request_log failure'); END",
  );
  assert.throws(() => enqueue(gw), /injected request_log failure/);
  const deliveryId = assertOneAdmission(gw, "accepted", "delivery.enqueue");
  assert.equal(gw.store.getRequest(REQUEST_ID), null);
  side.exec("DROP TRIGGER block_log");
  side.close();

  const retried = enqueue(gw);
  assert.deepEqual(retried, ok(deliveryId, "accepted"));
  assert.deepEqual(enqueue(gw), retried);
  assert.deepEqual(sent, [deliveryId]);
  assert.equal(gw.store.getRouteDay(ROUTE_KEY, DAY), 1);
  gw.close();
  cleanup(dir);
});

test("a same-requestId retry whose top-level dedup read misses answers the settled row from the enqueue admission recheck", async (t) => {
  const dir = tmpDir();
  const dbPath = join(dir, "gateway.sqlite");
  const clock = new TestClock(START_MS);
  const sent: string[] = [];
  const receipt = deferred<SendReceipt>();
  const owner = open(dbPath, clock, countingAdapter(sent, undefined, () => receipt.promise));
  const first = enqueue(owner);
  const deliveryId = requestDelivery(owner)[0]?.delivery_id ?? "";
  assert.deepEqual(first, ok(deliveryId, "dispatching"), "the send is still in flight");
  receipt.resolve({ receiptLevel: "accepted" });
  await flushAsync();
  assert.equal(
    (JSON.parse(owner.store.getRequest(REQUEST_ID) ?? "{}") as { body?: { status?: string } }).body?.status,
    "dispatching",
    "the recorded snapshot is still the pre-receipt one, so only the recheck can answer live",
  );

  const racer = openOtherWriter(dbPath, clock, countingAdapter(sent));
  staleDedupReads(t, racer.store);
  const raced = enqueue(racer);
  t.mock.restoreAll();
  assert.deepEqual(raced, ok(deliveryId, "accepted"), "the admission recheck replays the live row");
  assertOneAdmission(owner, "accepted", "delivery.enqueue");
  assert.deepEqual(sent, [deliveryId], "the raced retry does not send again");
  owner.close();
  racer.close();
  cleanup(dir);
});

test("a job.create replaying a recorded enqueue response answers the live row and admits no job", async (t) => {
  const dir = tmpDir();
  const dbPath = join(dir, "gateway.sqlite");
  const clock = new TestClock(START_MS);
  const sent: string[] = [];
  const receipt = deferred<SendReceipt>();
  const owner = open(dbPath, clock, countingAdapter(sent, undefined, () => receipt.promise));
  const first = enqueue(owner);
  const deliveryId = requestDelivery(owner)[0]?.delivery_id ?? "";
  receipt.resolve({ receiptLevel: "accepted" });
  await flushAsync();
  assert.deepEqual(first, ok(deliveryId, "dispatching"));

  const racer = openOtherWriter(dbPath, clock, countingAdapter(sent));
  staleDedupReads(t, racer.store);
  const replayed = handle(racer, "job.create", JOB_BODY, racer.clock.nowMs(), REQUEST_ID);
  t.mock.restoreAll();
  assert.deepEqual(replayed, ok(deliveryId, "accepted"), "the job recheck replays the live delivery row");
  assert.equal(racer.store.listJobs().length, 0, "the replay admits no job");
  assertOneAdmission(owner, "accepted", "delivery.enqueue");
  assert.deepEqual(sent, [deliveryId]);
  owner.close();
  racer.close();
  cleanup(dir);
});
