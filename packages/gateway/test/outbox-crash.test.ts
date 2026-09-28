import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { PROTOCOL_VERSION } from "pi-hermes-gateway-protocol";
import { createFakeAdapter, openGateway, sendIpc, startDaemon, TestClock, type SendAdapter } from "../dist/index.js";
import { listenIpc } from "../dist/ipc.js";
import { cleanup, collectUnhandledRejections, flushAsync, handle, openTestGw, ROUTE, tmpDir } from "./helpers.ts";

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

function openAsyncGw(send: SendAdapter["send"]) {
  const dir = tmpDir();
  const clock = new TestClock(Date.UTC(2026, 0, 1, 10, 0, 0));
  const adapter: SendAdapter = { manifest: createFakeAdapter().manifest, send };
  const { gateway } = openGateway({ dbPath: join(dir, "gateway.sqlite"), clock, routes: [ROUTE], adapter });
  return { gw: gateway, clock, dir };
}

test("crash before receipt write with async receipt: commit-unknown, sent once, drain stops", async () => {
  let sends = 0;
  const { gw, clock, dir } = openAsyncGw(async (envelope) => {
    sends += 1;
    return { receiptLevel: "accepted", providerMessageId: `p:${envelope.deliveryId}` };
  });
  const unhandled = await collectUnhandledRejections(async () => {
    gw.crashNext = "before-receipt";
    enqueueNow(gw, clock.nowMs(), "a");
    await flushAsync();
    const row = gw.store.listDeliveries()[0];
    assert.equal(row?.status, "commit-unknown");
    assert.ok(gw.store.listAudit().some((a) => a.kind === "crash.before-receipt"));
    assert.equal(gw.crashNext, null);
    gw.processOutbox();
    await flushAsync();
  });
  assert.deepEqual(unhandled, []);
  assert.equal(sends, 1);
  gw.close();
  cleanup(dir);
});

test("crash mid-send with async rejection: commit-unknown, never auto-retried", async () => {
  let sends = 0;
  const { gw, clock, dir } = openAsyncGw(async () => {
    sends += 1;
    throw new Error("injected async mid-send crash");
  });
  const unhandled = await collectUnhandledRejections(async () => {
    gw.crashNext = "mid-send";
    enqueueNow(gw, clock.nowMs());
    await flushAsync();
    assert.equal(gw.store.listDeliveries()[0]?.status, "commit-unknown");
    assert.ok(gw.store.listAudit().some((a) => a.kind === "crash.mid-send"));
    gw.processOutbox();
    await flushAsync();
  });
  assert.deepEqual(unhandled, []);
  assert.equal(sends, 1);
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

test("open converts leftover dispatching rows to commit-unknown with audit", () => {
  const { gw, clock, dir } = openTestGw();
  enqueueNow(gw, clock.nowMs());
  const row = gw.store.listDeliveries()[0]!;
  gw.store.setDispatchIntent(row.delivery_id);
  assert.equal(gw.store.getDelivery(row.delivery_id)?.status, "dispatching");
  gw.close();
  const clock2 = new TestClock(clock.nowMs());
  const { gateway: gw2 } = openGateway({
    dbPath: join(dir, "gateway.sqlite"),
    clock: clock2,
    routes: [ROUTE],
  });
  assert.equal(gw2.store.getDelivery(row.delivery_id)?.status, "commit-unknown");
  assert.ok(gw2.store.listAudit().some((a) => a.kind === "crash.recover"));
  gw2.processOutbox();
  assert.equal(gw2.store.getDelivery(row.delivery_id)?.status, "commit-unknown");
  gw2.close();
  cleanup(dir);
});

test("SIGKILL child leaving dispatching is recovered on open", async () => {
  const dir = tmpDir();
  const dbPath = join(dir, "gateway.sqlite");
  const storeUrl = new URL("../dist/store.js", import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
      import { Store } from ${JSON.stringify(storeUrl)};
      const store = new Store(${JSON.stringify(dbPath)});
      store.migrate();
      store.insertDelivery({
        delivery_id: "dlv_kill",
        job_id: null,
        occurrence_id: null,
        source: "enqueue",
        route_json: "{}",
        text: "k",
        not_after_ms: Date.now() + 60_000,
        status: "dispatching",
        request_id: null,
        created_at_ms: Date.now(),
        dispatch_intent: 1,
      });
      store.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
      console.log("ready");
      setInterval(() => {}, 1000);
      `,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("child ready timeout")), 5000);
    child.stdout?.on("data", (chunk: Uint8Array | string) => {
      if (String(chunk).includes("ready")) {
        clearTimeout(t);
        resolve();
      }
    });
    child.once("error", reject);
  });
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
  const clock = new TestClock(Date.UTC(2026, 0, 1, 10, 0, 0));
  const { gateway } = openGateway({ dbPath, clock, routes: [ROUTE] });
  assert.equal(gateway.store.getDelivery("dlv_kill")?.status, "commit-unknown");
  assert.ok(gateway.store.listAudit().some((a) => a.kind === "crash.recover"));
  gateway.close();
  cleanup(dir);
});

test("retry same requestId with delivery but no request_log returns existing status without fuses", () => {
  const { gw, clock, dir, adapter } = openTestGw();
  const reqId = "crash-retry-1";
  const now = clock.nowMs();
  const routeDayKey = "profile-a/fake/acct-1/chat-1/";
  const day = "2026-01-01";
  gw.store.insertDelivery({
    delivery_id: "dlv_prior",
    job_id: null,
    occurrence_id: null,
    source: "enqueue",
    route_json: JSON.stringify(ROUTE),
    text: "hello",
    not_after_ms: now + 60_000,
    status: "commit-unknown",
    request_id: reqId,
    created_at_ms: now,
    dispatch_intent: 1,
  });
  gw.store.setRouteDay(routeDayKey, day, 1);
  const res = handle(
    gw,
    "delivery.enqueue",
    { route: ROUTE, text: "hello", notAfter: now + 60_000 },
    now,
    reqId,
  );
  assert.equal(res.ok, true);
  if (res.ok) {
    const body = res.body as { deliveryId: string; status: string };
    assert.equal(body.deliveryId, "dlv_prior");
    assert.equal(body.status, "commit-unknown");
  }
  assert.equal(adapter.sent.length, 0);
  assert.equal(gw.store.listDeliveries().length, 1);
  assert.equal(gw.store.getRouteDay(routeDayKey, day), 1);
  gw.close();
  cleanup(dir);
});

test("SIGKILL after job insert before request_log: same requestId retry gives 1 job and 1 send per slot", async () => {
  const dir = tmpDir();
  const dbPath = join(dir, "gateway.sqlite");
  const indexUrl = new URL("../dist/index.js", import.meta.url).href;
  const t0 = Date.UTC(2026, 0, 1, 11, 0, 0);
  const body = {
    kind: "static-text",
    text: "daily",
    route: ROUTE,
    schedule: { type: "daily", timeZone: "UTC", localTime: "12:00" },
  };
  const req = { protocolVersion: PROTOCOL_VERSION, requestId: "job-kill-1", method: "job.create", expiresAt: t0 + 30_000, body };
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
      import { openGateway, TestClock } from ${JSON.stringify(indexUrl)};
      const { gateway } = openGateway({
        dbPath: ${JSON.stringify(dbPath)},
        clock: new TestClock(${t0}),
        routes: [${JSON.stringify(ROUTE)}],
      });
      const insertJob = gateway.store.insertJob.bind(gateway.store);
      gateway.store.insertJob = (row) => {
        insertJob(row);
        console.log("job-inserted");
      };
      gateway.store.putRequest = () => process.kill(process.pid, "SIGKILL");
      const req = ${JSON.stringify(req)};
      gateway.handleRequest(req, Buffer.byteLength(JSON.stringify(req)));
      console.log("not-killed");
      `,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  child.stdout?.on("data", (chunk: Uint8Array | string) => {
    stdout += String(chunk);
  });
  const signal = await new Promise((resolve) => child.once("exit", (_code, sig) => resolve(sig)));
  assert.equal(signal, "SIGKILL");
  assert.ok(stdout.includes("job-inserted"));
  assert.ok(!stdout.includes("not-killed"));

  const clock = new TestClock(t0 + 1_000);
  const adapter = createFakeAdapter();
  const { gateway } = openGateway({ dbPath, clock, routes: [ROUTE], adapter });
  const first = handle(gateway, "job.create", body, clock.nowMs(), "job-kill-1");
  const second = handle(gateway, "job.create", body, clock.nowMs(), "job-kill-1");
  assert.equal(first.ok, true);
  assert.deepEqual(second, first);
  assert.equal(gateway.store.listJobs().length, 1);
  clock.set(Date.UTC(2026, 0, 1, 12, 0, 10));
  gateway.tick();
  assert.equal(adapter.sent.length, 1);
  clock.set(Date.UTC(2026, 0, 2, 12, 0, 10));
  gateway.tick();
  assert.equal(adapter.sent.length, 2);
  gateway.close();
  cleanup(dir);
});

test("IPC handleRequest exception returns error frame and keeps listening", async () => {
  const dir = tmpDir();
  const sock = join(dir, "gw.sock");
  let calls = 0;
  const gateway = {
    handleRequest() {
      calls += 1;
      if (calls === 1) throw new Error("injected handler crash");
      return { ok: false, error: { code: "unknown_method", message: "unknown method" } };
    },
  };
  const server = listenIpc(sock, gateway as never);
  const r1 = await sendIpc(sock, { ping: 1 });
  assert.equal((r1 as { ok: boolean }).ok, false);
  assert.equal((r1 as { error: { code: string } }).error.code, "internal");
  const r2 = await sendIpc(sock, { ping: 2 });
  assert.equal((r2 as { ok: boolean }).ok, false);
  assert.equal((r2 as { error: { code: string } }).error.code, "unknown_method");
  server.close();
  cleanup(dir);
});

test("client write-and-destroy does not kill IPC daemon; next request is answered", async () => {
  const dir = tmpDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const indexUrl = new URL("../dist/index.js", import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
      import { startDaemon } from ${JSON.stringify(indexUrl)};
      const ROUTE = ${JSON.stringify(ROUTE)};
      startDaemon({ profileDir: ${JSON.stringify(dir)}, routes: [ROUTE] });
      process.stdout.write("listening\\n");
      `,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let out = "";
  child.stdout?.on("data", (chunk: Uint8Array | string) => {
    out += String(chunk);
  });
  child.stderr?.on("data", (chunk: Uint8Array | string) => {
    out += String(chunk);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`child listening timeout: ${out}`)), 5000);
      const iv = setInterval(() => {
        if (out.includes("listening")) {
          clearInterval(iv);
          clearTimeout(t);
          resolve();
        }
      }, 10);
      child.once("error", reject);
    });
    const sock = join(dir, "gateway.sock");
    const now = Date.now();
    const json = Buffer.from(
      JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        requestId: "client-reset-1",
        method: "job.list",
        body: {},
        expiresAt: now + 30_000,
      }),
    );
    const buf = Buffer.alloc(4 + json.length);
    buf.writeUInt32BE(json.length, 0);
    json.copy(buf, 4);
    for (let i = 0; i < 20 && child.exitCode === null && child.signalCode === null; i++) {
      await new Promise<void>((resolve) => {
        const s = createConnection(sock, () => {
          s.write(buf);
          s.destroy();
          resolve();
        });
        s.on("error", () => resolve());
      });
      await new Promise((r) => setTimeout(r, 5));
    }
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 100)),
    ]);
    assert.equal(child.exitCode, null, `daemon exited after client reset: ${out}`);
    assert.equal(child.signalCode, null);
    const stillUp = await sendIpc(sock, {
      protocolVersion: PROTOCOL_VERSION,
      requestId: "after-reset",
      method: "job.list",
      body: {},
      expiresAt: Date.now() + 30_000,
    });
    assert.equal((stillUp as { ok: boolean }).ok, true);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once("exit", () => resolve());
    });
    cleanup(dir);
  }
});

test("SIGKILL mid-send then same requestId retry returns commit-unknown without extra send", async () => {
  const dir = tmpDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const indexUrl = new URL("../dist/index.js", import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
      import { startDaemon, createFakeAdapter } from ${JSON.stringify(indexUrl)};
      const ROUTE = ${JSON.stringify(ROUTE)};
      const adapter = createFakeAdapter();
      const orig = adapter.send.bind(adapter);
      adapter.send = (env) => {
        process.stdout.write("in-send\\n");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        return orig(env);
      };
      startDaemon({ profileDir: ${JSON.stringify(dir)}, routes: [ROUTE], adapter });
      process.stdout.write("listening\\n");
      `,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let out = "";
  child.stdout?.on("data", (chunk: Uint8Array | string) => {
    out += String(chunk);
  });
  child.stderr?.on("data", (chunk: Uint8Array | string) => {
    out += String(chunk);
  });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`child listening timeout: ${out}`)), 5000);
    const iv = setInterval(() => {
      if (out.includes("listening")) {
        clearInterval(iv);
        clearTimeout(t);
        resolve();
      }
    }, 10);
    child.once("error", reject);
  });
  const sock = join(dir, "gateway.sock");
  const now = Date.now();
  const request = {
    protocolVersion: PROTOCOL_VERSION,
    requestId: "client-retry-1",
    method: "delivery.enqueue",
    body: { route: ROUTE, text: "hello", notAfter: now + 3_600_000 },
    expiresAt: now + 55_000,
  };
  sendIpc(sock, request).catch(() => {});
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`in-send timeout: ${out}`)), 5000);
    const iv = setInterval(() => {
      if (out.includes("in-send")) {
        clearInterval(iv);
        clearTimeout(t);
        resolve();
      }
    }, 10);
  });
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
  const adapter = createFakeAdapter();
  const daemon = startDaemon({ profileDir: dir, routes: [ROUTE], adapter });
  try {
    const resp = await Promise.race([
      sendIpc(sock, request),
      new Promise((_, reject) => setTimeout(() => reject(new Error("retry ipc timeout")), 3000)),
    ]);
    assert.equal((resp as { ok: boolean }).ok, true);
    const body = (resp as { body: { deliveryId: string; status: string } }).body;
    assert.equal(typeof body.deliveryId, "string");
    assert.equal(body.status, "commit-unknown");
    assert.equal(adapter.sent.length, 0);
    assert.equal(daemon.gateway.store.listDeliveries().length, 1);
    const day = new Date(daemon.gateway.clock.nowMs()).toISOString().slice(0, 10);
    assert.equal(daemon.gateway.store.getRouteDay("profile-a/fake/acct-1/chat-1/", day), 1);
    const stillUp = await sendIpc(sock, {
      protocolVersion: PROTOCOL_VERSION,
      requestId: "after-retry-ping",
      method: "job.list",
      body: {},
      expiresAt: Date.now() + 30_000,
    });
    assert.equal((stillUp as { ok: boolean }).ok, true);
  } finally {
    daemon.stop();
    cleanup(dir);
  }
});
