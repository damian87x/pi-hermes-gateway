import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { ADAPTER_API_VERSION, LIMITS, validateAdapterManifest } from "pi-hermes-gateway-protocol";
import { acquireProfileLock, openGateway, startDaemon, TestClock, type Gateway } from "../dist/index.js";
import { createFakeAdapter } from "../dist/fake-adapter.js";
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

function stubAdapter(adapterId: string, sent: string[]) {
  const manifestResult = validateAdapterManifest({
    adapterId,
    adapterApiVersion: ADAPTER_API_VERSION,
    capabilities: ["send.text"],
    configSchemaVersion: 1,
    maxTextLength: LIMITS.maxTextChars,
    receiptLevels: ["accepted"],
  });
  if (!manifestResult.ok) throw new Error(manifestResult.error.message);
  return {
    manifest: manifestResult.value,
    send(envelope: { deliveryId: string }) {
      sent.push(envelope.deliveryId);
      return { receiptLevel: "accepted" as const, providerMessageId: `${adapterId}:${envelope.deliveryId}` };
    },
  };
}

test("daemon startup rejects configured routes whose adapterId differs from the loaded adapter", () => {
  const dir = tmpDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const clock = new TestClock(Date.UTC(2026, 0, 1, 10, 0, 0));
  const sent: string[] = [];
  const telegramRoute = { ...ROUTE, adapterId: "telegram" };
  assert.throws(() => {
    startDaemon({ profileDir: dir, routes: [ROUTE], adapter: stubAdapter("telegram", sent), clock, bindSocket: false });
  }, /adapterId/);
  assert.throws(() => {
    startDaemon({ profileDir: dir, routes: [telegramRoute], clock, bindSocket: false });
  }, /adapterId/);
  const d = startDaemon({
    profileDir: dir,
    routes: [telegramRoute],
    adapter: stubAdapter("telegram", sent),
    clock,
    bindSocket: false,
  });
  const res = handle(d.gateway, "delivery.enqueue", { route: telegramRoute, text: "hi", notAfter: clock.nowMs() + 60_000 }, clock.nowMs());
  assert.equal(res.ok, true);
  assert.equal(sent.length, 1);
  d.stop();
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

test("profile lock is node-only; holder death releases; no split-brain while held", async () => {
  const lockSrc = readFileSync(new URL("../src/lock.ts", import.meta.url), "utf8");
  assert.equal(lockSrc.includes("python3"), false);
  assert.equal(lockSrc.includes("child_process"), false);
  const cliSrc = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
  assert.equal(cliSrc.includes("TestClock"), false);
  const dir = tmpDir();
  const lockPath = join(dir, "profile.lock");
  const held = acquireProfileLock(lockPath);
  assert.throws(() => acquireProfileLock(lockPath), /profile lock held/);
  held.release();
  const again = acquireProfileLock(lockPath);
  again.release();

  const lockUrl = new URL("../dist/lock.js", import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
      import { acquireProfileLock } from ${JSON.stringify(lockUrl)};
      const h = acquireProfileLock(${JSON.stringify(lockPath)});
      console.log("held");
      setInterval(() => {}, 1000);
      void h;
      `,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("lock child ready timeout")), 5000);
    child.stdout?.on("data", (chunk: Uint8Array | string) => {
      if (String(chunk).includes("held")) {
        clearTimeout(t);
        resolve();
      }
    });
    child.once("error", reject);
  });
  assert.throws(() => acquireProfileLock(lockPath), /profile lock held/);
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
  const afterDeath = acquireProfileLock(lockPath);
  afterDeath.release();
  cleanup(dir);
});

test("default daemon clock advances and ticks within 60s", async () => {
  const dir = tmpDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  writeFileSync(join(dir, "config.json"), JSON.stringify({ routes: [ROUTE] }), { mode: 0o600 });
  const d = startDaemon({ profileDir: dir, routes: [ROUTE], bindSocket: false, tickIntervalMs: 40 });
  assert.equal(d.gateway.clock.constructor.name, "SystemClock");
  const t0 = d.gateway.clock.nowMs();
  const due = new Date(t0 + 70).toISOString();
  const req = wire(
    "job.create",
    {
      kind: "static-text",
      text: "tick-me",
      route: ROUTE,
      schedule: { type: "once", atUtc: due },
    },
    d.gateway.clock.nowMs(),
  );
  const res = d.gateway.handleRequest(req, frameLen(req));
  assert.equal(res.ok, true);
  await new Promise((resolve) => setTimeout(resolve, 220));
  assert.ok(d.gateway.clock.nowMs() - t0 >= 50);
  assert.equal(d.adapter.sent.length, 1);
  d.stop();
  cleanup(dir);
});

function hasInvalidRouteSendReject(gw: { store: { listAudit: () => { kind: string; payload_json: string }[] } }): boolean {
  return gw.store.listAudit().some((r) => {
    if (r.kind !== "delivery.send.rejected") return false;
    const payload = JSON.parse(r.payload_json) as { reason?: string };
    return payload.reason === "invalid_route";
  });
}

test("job on revoked route: reopen tick does not send and audits refusal", () => {
  const R2 = { ...ROUTE, chatId: "chat-2" };
  const { gw, clock, dir } = openTestGw({ routes: [ROUTE, R2] });
  const at = "2026-01-01T12:00:00.000Z";
  const created = handle(
    gw,
    "job.create",
    {
      kind: "static-text",
      text: "revoked-job",
      route: R2,
      schedule: { type: "once", atUtc: at },
    },
    clock.nowMs(),
  );
  assert.equal(created.ok, true);
  gw.close();

  const clock2 = new TestClock(Date.parse(at));
  const { gw: gw2, adapter } = openTestGw({ clock: clock2, routes: [ROUTE], dir });
  gw2.tick();
  assert.equal(adapter.sent.length, 0);
  assert.ok(hasInvalidRouteSendReject(gw2));
  const occ = gw2.store.listOccurrences();
  assert.ok(occ.length >= 1);
  assert.ok(occ.every((row) => row.status === "skipped" || row.status === "refused"));
  gw2.close();
  cleanup(dir);
});

test("queued enqueue on revoked route: reopen tick does not send and audits refusal", () => {
  const R2 = { ...ROUTE, chatId: "chat-2" };
  const { gw, clock, dir } = openTestGw({ routes: [ROUTE, R2] });
  gw.store.setMeta("dispatch_enabled", "0");
  const enq = handle(
    gw,
    "delivery.enqueue",
    { route: R2, text: "queued-revoked", notAfter: clock.nowMs() + 60_000 },
    clock.nowMs(),
  );
  assert.equal(enq.ok, true);
  assert.equal(gw.store.listDeliveries()[0]?.status, "queued");
  gw.close();

  const { gw: gw2, adapter } = openTestGw({ clock, routes: [ROUTE], dir });
  gw2.store.setMeta("dispatch_enabled", "1");
  gw2.tick();
  assert.equal(adapter.sent.length, 0);
  const delivery = gw2.store.listDeliveries()[0];
  assert.ok(delivery);
  assert.ok(delivery.status === "failed" || delivery.status === "refused");
  assert.ok(hasInvalidRouteSendReject(gw2));
  gw2.close();
  cleanup(dir);
});

for (const fault of [
  {
    name: "queued delivery insert",
    trigger: "BEFORE INSERT ON deliveries WHEN NEW.source = 'enqueue'",
    requireApproval: false,
    crossesNotAfter: false,
    status: "accepted",
  },
  {
    name: "queued admission audit",
    trigger: "BEFORE INSERT ON audit WHEN NEW.kind = 'delivery.enqueue'",
    requireApproval: false,
    crossesNotAfter: false,
    status: "accepted",
  },
  {
    name: "pending-approval admission audit",
    trigger: "BEFORE INSERT ON audit WHEN NEW.kind = 'delivery.enqueue'",
    requireApproval: true,
    crossesNotAfter: false,
    status: "pending-approval",
  },
  {
    name: "expired delivery insert",
    trigger: "BEFORE INSERT ON deliveries WHEN NEW.source = 'enqueue'",
    requireApproval: false,
    crossesNotAfter: true,
    status: "expired",
  },
  {
    name: "expired audit",
    trigger: "BEFORE INSERT ON audit WHEN NEW.kind = 'delivery.expired'",
    requireApproval: false,
    crossesNotAfter: true,
    status: "expired",
  },
]) {
  test(`enqueue whose ${fault.name} fails spends no fuse; the same requestId then admits once without a double send`, () => {
    const dir = tmpDir();
    const dbPath = join(dir, "gateway.sqlite");
    const clock = new TestClock(Date.UTC(2026, 0, 1, 10, 0, 0));
    const adapter = createFakeAdapter();
    const open = () =>
      openGateway({
        dbPath,
        clock,
        routes: [ROUTE],
        adapter,
        tokenBucketCapacity: 1,
        tokenBucketRefillPerMs: 0,
        dailyCapPerRoute: 1,
      }).gateway;
    // Wire validation refuses notAfter <= now, so the expired branch needs the clock to pass notAfter
    // after the request's first (validation) read.
    const readNow = clock.nowMs.bind(clock);
    let reads = -1;
    clock.nowMs = () => (reads >= 0 && reads++ > 0 ? readNow() + 60_000 : readNow());
    const gw = open();
    const reqId = `enqueue-fault-${fault.name.replaceAll(" ", "-")}`;
    const body = { route: ROUTE, text: "fuse", notAfter: readNow() + 60_000, requireApproval: fault.requireApproval };
    const enqueue = (target: Gateway) => {
      reads = fault.crossesNotAfter ? 0 : -1;
      try {
        return handle(target, "delivery.enqueue", body, readNow(), reqId);
      } finally {
        reads = -1;
      }
    };
    const side = new DatabaseSync(dbPath);
    side.exec(`CREATE TRIGGER block_enqueue ${fault.trigger} BEGIN SELECT RAISE(ABORT, 'injected enqueue write failure'); END`);
    assert.throws(() => enqueue(gw), /injected enqueue write failure/);
    assert.deepEqual(gw.store.listDeliveries(), []);
    assert.equal(gw.store.getAccountFuse(ROUTE.accountId), undefined, "the token debit rolls back with the delivery");
    const fuseRows = side.prepare("SELECT (SELECT COUNT(*) FROM fuse_account) + (SELECT COUNT(*) FROM fuse_route_day) AS n").get();
    assert.equal(fuseRows?.n, 0, "neither the token nor the daily-cap debit is committed");
    const kinds = gw.store.listAudit().map((a) => a.kind);
    assert.equal(kinds.includes("delivery.enqueue"), false);
    assert.equal(kinds.includes("delivery.expired"), false);
    assert.equal(gw.store.getRequest(reqId), null, "a failed admission is not recorded as the request's response");
    assert.equal(adapter.sent.length, 0);
    side.exec("DROP TRIGGER block_enqueue");
    side.close();

    const retried = enqueue(gw);
    assert.equal(retried.ok, true, "the retry is not rate limited by a phantom debit");
    if (retried.ok) assert.equal((retried.body as { status: string }).status, fault.status);
    assert.deepEqual(enqueue(gw), retried);
    assert.equal(gw.store.listDeliveries().length, 1);
    assert.equal(gw.store.getAccountFuse(ROUTE.accountId)?.tokens, 0, "exactly one token is spent");
    assert.equal(adapter.sent.length, fault.status === "accepted" ? 1 : 0);
    gw.close();

    const reopened = open();
    assert.deepEqual(enqueue(reopened), retried);
    assert.equal(reopened.store.listDeliveries().length, 1);
    assert.equal(adapter.sent.length, fault.status === "accepted" ? 1 : 0, "restart never resends");
    reopened.close();
    cleanup(dir);
  });
}
