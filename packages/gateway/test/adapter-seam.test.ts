import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ADAPTER_API_VERSION,
  LIMITS,
  validateAdapterManifest,
  type DeliveryRoute,
} from "pi-hermes-gateway-protocol";
import { createTelegramAdapter } from "../../adapter-telegram/src/index.ts";
import { createSlackAdapter } from "../../adapter-slack/src/index.ts";
import { loadSendAdapter } from "../dist/adapter-loader.js";
import { isSendAdapter } from "../dist/adapter.js";
import { openGateway, TestClock, type Gateway, type SendAdapter } from "../dist/index.js";
import {
  cleanup,
  collectUnhandledRejections,
  deferred,
  flushAsync,
  handle,
  openTestGw,
  ROUTE,
  tmpDir,
  type Deferred,
} from "./helpers.ts";

function plainAdapter(sent: string[]) {
  const manifestResult = validateAdapterManifest({
    adapterId: "plain",
    adapterApiVersion: ADAPTER_API_VERSION,
    capabilities: ["send.text"],
    configSchemaVersion: 1,
    maxTextLength: LIMITS.maxTextChars,
    receiptLevels: ["accepted"],
  });
  if (!manifestResult.ok) throw new Error(manifestResult.error.message);
  return {
    manifest: manifestResult.value,
    send(envelope: { deliveryId: string; text: string }) {
      sent.push(envelope.deliveryId);
      return { receiptLevel: "accepted" as const, providerMessageId: `plain:${envelope.deliveryId}` };
    },
  };
}

test("openGateway defaults to fake adapter", () => {
  const { gw, dir } = openTestGw();
  assert.equal(gw.adapter.manifest.adapterId, "fake");
  assert.equal(typeof gw.adapter.send, "function");
  gw.close();
  cleanup(dir);
});

test("gateway accepts a structural send adapter that is not FakeAdapter", () => {
  const dir = tmpDir();
  const sent: string[] = [];
  const adapter = plainAdapter(sent);
  assert.equal(isSendAdapter(adapter), true);
  const { gw, clock } = openTestGw({ dir });
  gw.close();
  const opened = openGateway({
    dbPath: join(dir, "plain.sqlite"),
    clock,
    routes: [ROUTE],
    adapter,
  });
  const res = handle(
    opened.gateway,
    "delivery.enqueue",
    { route: ROUTE, text: "hello", notAfter: clock.nowMs() + 60_000 },
    clock.nowMs(),
  );
  assert.equal(res.ok, true);
  assert.equal(sent.length, 1);
  opened.gateway.close();
  cleanup(dir);
});

test("adapter commit-unknown receipt is persisted and never auto-retried", () => {
  const dir = tmpDir();
  const { gw, clock } = openTestGw({ dir });
  gw.close();
  const manifestResult = validateAdapterManifest({
    adapterId: "plain",
    adapterApiVersion: ADAPTER_API_VERSION,
    capabilities: ["send.text"],
    configSchemaVersion: 1,
    maxTextLength: LIMITS.maxTextChars,
    receiptLevels: ["accepted"],
  });
  if (!manifestResult.ok) throw new Error(manifestResult.error.message);
  let calls = 0;
  const adapter = {
    manifest: manifestResult.value,
    send() {
      calls += 1;
      return { receiptLevel: "commit-unknown" as const, reason: "timeout" };
    },
  };
  const opened = openGateway({
    dbPath: join(dir, "unknown.sqlite"),
    clock,
    routes: [ROUTE],
    adapter,
  });
  handle(
    opened.gateway,
    "delivery.enqueue",
    { route: ROUTE, text: "hello", notAfter: clock.nowMs() + 60_000 },
    clock.nowMs(),
  );
  const row = opened.gateway.store.listDeliveries()[0];
  assert.equal(row?.status, "commit-unknown");
  assert.equal(calls, 1);
  opened.gateway.processOutbox();
  assert.equal(calls, 1);
  assert.equal(opened.gateway.store.getDelivery(row!.delivery_id)?.status, "commit-unknown");
  opened.gateway.close();
  cleanup(dir);
});

test("malformed synchronous adapter receipt is commit-unknown, never accepted", () => {
  const dir = tmpDir();
  const { gw, clock } = openTestGw({ dir });
  gw.close();
  const manifestResult = validateAdapterManifest({
    adapterId: "plain",
    adapterApiVersion: ADAPTER_API_VERSION,
    capabilities: ["send.text"],
    configSchemaVersion: 1,
    maxTextLength: LIMITS.maxTextChars,
    receiptLevels: ["accepted"],
  });
  if (!manifestResult.ok) throw new Error(manifestResult.error.message);
  const receipts: unknown[] = [{}, undefined, { receiptLevel: "maybe" }];
  const adapter = {
    manifest: manifestResult.value,
    send() {
      return receipts.shift() as { receiptLevel: "accepted" };
    },
  };
  const opened = openGateway({
    dbPath: join(dir, "unconfirmed.sqlite"),
    clock,
    routes: [ROUTE],
    adapter,
  });
  for (const text of ["a", "b", "c"]) {
    handle(opened.gateway, "delivery.enqueue", { route: ROUTE, text, notAfter: clock.nowMs() + 60_000 }, clock.nowMs());
  }
  const statuses = opened.gateway.store.listDeliveries().map((row) => row.status);
  assert.deepEqual(statuses, ["commit-unknown", "commit-unknown", "commit-unknown"]);
  opened.gateway.close();
  cleanup(dir);
});

test("loadSendAdapter imports a module path factory without class identity", async () => {
  const dir = tmpDir();
  mkdirSync(dir, { recursive: true });
  const modulePath = join(dir, "plain-adapter.mjs");
  writeFileSync(
    modulePath,
    `export function createAdapter(config) {
       return {
         manifest: {
           adapterId: config.id,
           adapterApiVersion: 1,
           capabilities: ["send.text"],
           configSchemaVersion: 1,
           maxTextLength: 4096,
           receiptLevels: ["accepted"],
         },
         send(envelope) {
           return { receiptLevel: "accepted", providerMessageId: "mod:" + envelope.deliveryId };
         },
       };
     }
    `,
  );
  const adapter = await loadSendAdapter(modulePath, { id: "from-module" }, dir);
  assert.equal(isSendAdapter(adapter), true);
  assert.equal(adapter.manifest.adapterId, "from-module");
  cleanup(dir);
});

const TELEGRAM_ROUTE: DeliveryRoute = { profileId: "profile-a", adapterId: "telegram", accountId: "bot-1", chatId: "1001" };
const SLACK_ROUTE: DeliveryRoute = { profileId: "profile-a", adapterId: "slack", accountId: "team-1", chatId: "C123" };

function openWith(adapter: SendAdapter, route: DeliveryRoute): { gw: Gateway; clock: TestClock; dir: string } {
  const dir = tmpDir();
  const clock = new TestClock(Date.UTC(2026, 0, 1, 10, 0, 0));
  const { gateway } = openGateway({ dbPath: join(dir, "gateway.sqlite"), clock, routes: [route], adapter });
  return { gw: gateway, clock, dir };
}

function enqueue(gw: Gateway, clock: TestClock, route: DeliveryRoute, text: string) {
  const res = handle(gw, "delivery.enqueue", { route, text, notAfter: clock.nowMs() + 60_000 }, clock.nowMs());
  if (!res.ok) throw new Error(res.error.message);
  return res.body as { deliveryId: string; status: string };
}

function plainManifest() {
  const manifestResult = validateAdapterManifest({
    adapterId: "fake",
    adapterApiVersion: ADAPTER_API_VERSION,
    capabilities: ["send.text"],
    configSchemaVersion: 1,
    maxTextLength: LIMITS.maxTextChars,
    receiptLevels: ["accepted"],
  });
  if (!manifestResult.ok) throw new Error(manifestResult.error.message);
  return manifestResult.value;
}

test("actual Telegram adapter with async fake HTTP settles to accepted after the receipt resolves", async () => {
  const http = deferred<{ kind: "ok"; status: number; json: unknown }>();
  let posts = 0;
  const adapter = createTelegramAdapter(
    { kind: "dedicated-bot", token: "123456:ABC-DEF_token" },
    {
      post: () => {
        posts += 1;
        return http.promise;
      },
    },
  );
  const { gw, clock, dir } = openWith(adapter, TELEGRAM_ROUTE);
  const unhandled = await collectUnhandledRejections(async () => {
    const body = enqueue(gw, clock, TELEGRAM_ROUTE, "hello telegram");
    assert.equal(body.status, "dispatching");
    assert.equal(gw.store.getDelivery(body.deliveryId)?.dispatch_intent, 1);
    http.resolve({ kind: "ok", status: 200, json: { ok: true, result: { message_id: 42 } } });
    await flushAsync();
    assert.equal(gw.store.getDelivery(body.deliveryId)?.status, "accepted");
    gw.processOutbox();
    await flushAsync();
  });
  assert.deepEqual(unhandled, []);
  assert.equal(posts, 1);
  assert.ok(gw.store.listAudit().some((a) => a.kind === "delivery.accepted"));
  gw.close();
  cleanup(dir);
});

test("actual Slack adapter with async fake HTTP settles to accepted after the receipt resolves", async () => {
  const http = deferred<{ kind: "ok"; status: number; json: unknown }>();
  let posts = 0;
  const adapter = createSlackAdapter(
    { kind: "bot-token", token: "xoxb-test-token" },
    {
      post: () => {
        posts += 1;
        return http.promise;
      },
    },
  );
  const { gw, clock, dir } = openWith(adapter, SLACK_ROUTE);
  const unhandled = await collectUnhandledRejections(async () => {
    const body = enqueue(gw, clock, SLACK_ROUTE, "hello slack");
    assert.equal(body.status, "dispatching");
    http.resolve({ kind: "ok", status: 200, json: { ok: true, ts: "1700000000.000100" } });
    await flushAsync();
    assert.equal(gw.store.getDelivery(body.deliveryId)?.status, "accepted");
  });
  assert.deepEqual(unhandled, []);
  assert.equal(posts, 1);
  gw.close();
  cleanup(dir);
});

test("actual Telegram and Slack adapters record async timeout or rejected HTTP as commit-unknown", async () => {
  const telegram = createTelegramAdapter(
    { kind: "dedicated-bot", token: "123456:ABC-DEF_token" },
    { post: async () => ({ kind: "timeout" as const }) },
  );
  const slack = createSlackAdapter(
    { kind: "bot-token", token: "xoxb-test-token" },
    { post: async () => Promise.reject(new Error("socket hang up xoxb-test-token")) },
  );
  for (const [adapter, route] of [
    [telegram, TELEGRAM_ROUTE],
    [slack, SLACK_ROUTE],
  ] as const) {
    const { gw, clock, dir } = openWith(adapter, route);
    const unhandled = await collectUnhandledRejections(async () => {
      const body = enqueue(gw, clock, route, "x");
      await flushAsync();
      assert.equal(gw.store.getDelivery(body.deliveryId)?.status, "commit-unknown");
    });
    assert.deepEqual(unhandled, []);
    assert.equal(JSON.stringify(gw.store.listAudit()).includes("xoxb-test-token"), false);
    gw.close();
    cleanup(dir);
  }
});

test("Telegram adapter loaded with its default HTTP client settles accepted against a loopback fake server", async () => {
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, result: { message_id: 7 } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("expected tcp address");
  const modulePath = fileURLToPath(new URL("../../adapter-telegram/src/index.ts", import.meta.url));
  const adapter = await loadSendAdapter(modulePath, {
    kind: "dedicated-bot",
    token: "123456:ABC-DEF_token",
    apiOrigin: `http://127.0.0.1:${addr.port}`,
  });
  const { gw, clock, dir } = openWith(adapter, TELEGRAM_ROUTE);
  try {
    const body = enqueue(gw, clock, TELEGRAM_ROUTE, "loopback");
    for (let i = 0; i < 100 && gw.store.getDelivery(body.deliveryId)?.status === "dispatching"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(gw.store.getDelivery(body.deliveryId)?.status, "accepted");
  } finally {
    gw.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    cleanup(dir);
  }
});

test("generic adapter rejected Promise is commit-unknown, not unhandled, and never auto-retried", async () => {
  let calls = 0;
  const adapter: SendAdapter = {
    manifest: plainManifest(),
    send() {
      calls += 1;
      return Promise.reject(new Error("transport exploded"));
    },
  };
  const { gw, clock, dir } = openWith(adapter, ROUTE);
  let deliveryId = "";
  const unhandled = await collectUnhandledRejections(async () => {
    deliveryId = enqueue(gw, clock, ROUTE, "x").deliveryId;
    await flushAsync();
    gw.processOutbox();
    gw.tick();
    await flushAsync();
  });
  assert.deepEqual(unhandled, []);
  assert.equal(calls, 1);
  assert.equal(gw.store.getDelivery(deliveryId)?.status, "commit-unknown");
  const audit = gw.store.listAudit().find((a) => a.kind === "delivery.commit-unknown");
  assert.ok(audit);
  assert.equal(audit.payload_json.includes("transport exploded"), false);
  gw.close();
  cleanup(dir);
});

test("synchronous adapter throw is commit-unknown and never auto-retried", () => {
  let calls = 0;
  const adapter: SendAdapter = {
    manifest: plainManifest(),
    send() {
      calls += 1;
      throw new Error("sync transport exploded");
    },
  };
  const { gw, clock, dir } = openWith(adapter, ROUTE);
  const body = enqueue(gw, clock, ROUTE, "x");
  assert.equal(body.status, "commit-unknown");
  gw.processOutbox();
  assert.equal(calls, 1);
  assert.equal(gw.store.getDelivery(body.deliveryId)?.status, "commit-unknown");
  gw.close();
  cleanup(dir);
});

test("async resolved commit-unknown receipt is persisted and never auto-retried", async () => {
  let calls = 0;
  const adapter: SendAdapter = {
    manifest: plainManifest(),
    async send() {
      calls += 1;
      return { receiptLevel: "commit-unknown", reason: "timeout" };
    },
  };
  const { gw, clock, dir } = openWith(adapter, ROUTE);
  const body = enqueue(gw, clock, ROUTE, "x");
  await flushAsync();
  assert.equal(gw.store.getDelivery(body.deliveryId)?.status, "commit-unknown");
  gw.processOutbox();
  await flushAsync();
  assert.equal(calls, 1);
  gw.close();
  cleanup(dir);
});

test("overlapping enqueues and ticks drain once: one send in flight, each delivery sent exactly once", async () => {
  const pending: Array<{ deliveryId: string; receipt: Deferred<{ receiptLevel: "accepted"; providerMessageId: string }> }> = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const adapter: SendAdapter = {
    manifest: plainManifest(),
    send(envelope) {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const receipt = deferred<{ receiptLevel: "accepted"; providerMessageId: string }>();
      pending.push({ deliveryId: envelope.deliveryId, receipt });
      return receipt.promise.finally(() => {
        inFlight -= 1;
      });
    },
  };
  const { gw, clock, dir } = openWith(adapter, ROUTE);
  const ids: string[] = [];
  const unhandled = await collectUnhandledRejections(async () => {
    ids.push(enqueue(gw, clock, ROUTE, "a").deliveryId);
    ids.push(enqueue(gw, clock, ROUTE, "b").deliveryId);
    gw.tick();
    gw.processOutbox();
    ids.push(enqueue(gw, clock, ROUTE, "c").deliveryId);
    gw.tick();
    for (let i = 0; i < ids.length; i += 1) {
      await flushAsync();
      assert.equal(pending.length, i + 1, "exactly one send is in flight at a time");
      const next = pending[i]!;
      next.receipt.resolve({ receiptLevel: "accepted", providerMessageId: `p:${next.deliveryId}` });
      gw.tick();
      gw.processOutbox();
    }
    await flushAsync();
  });
  assert.deepEqual(unhandled, []);
  assert.equal(maxInFlight, 1);
  assert.deepEqual(
    pending.map((p) => p.deliveryId),
    ids,
  );
  for (const id of ids) assert.equal(gw.store.getDelivery(id)?.status, "accepted");
  gw.close();
  cleanup(dir);
});

test("hung async send leaves its row dispatching; close does not wait and reopen records commit-unknown", async () => {
  let calls = 0;
  const adapter: SendAdapter = {
    manifest: plainManifest(),
    send() {
      calls += 1;
      return new Promise(() => {});
    },
  };
  const { gw, clock, dir } = openWith(adapter, ROUTE);
  const body = enqueue(gw, clock, ROUTE, "x");
  assert.equal(body.status, "dispatching");
  await flushAsync();
  assert.equal(gw.store.getDelivery(body.deliveryId)?.status, "dispatching");
  gw.close();
  const reopened = openGateway({ dbPath: join(dir, "gateway.sqlite"), clock, routes: [ROUTE], adapter });
  assert.equal(reopened.gateway.store.getDelivery(body.deliveryId)?.status, "commit-unknown");
  reopened.gateway.processOutbox();
  assert.equal(calls, 1);
  reopened.gateway.close();
  cleanup(dir);
});

type AcceptedReceipt = { receiptLevel: "accepted"; providerMessageId: string };

function reentrantDeferredAdapter(onFirstSend: () => void) {
  const pending: Array<{ deliveryId: string; receipt: Deferred<AcceptedReceipt> }> = [];
  const track = { inFlight: 0, maxInFlight: 0 };
  const adapter: SendAdapter = {
    manifest: plainManifest(),
    send(envelope) {
      track.inFlight += 1;
      track.maxInFlight = Math.max(track.maxInFlight, track.inFlight);
      const receipt = deferred<AcceptedReceipt>();
      pending.push({ deliveryId: envelope.deliveryId, receipt });
      if (pending.length === 1) onFirstSend();
      return receipt.promise.finally(() => {
        track.inFlight -= 1;
      });
    },
  };
  return { adapter, pending, track };
}

test("send that synchronously enqueues another delivery keeps one send in flight and sends it once after the first settles", async () => {
  let gw!: Gateway;
  let clock!: TestClock;
  let second = "";
  const { adapter, pending, track } = reentrantDeferredAdapter(() => {
    second = enqueue(gw, clock, ROUTE, "second").deliveryId;
  });
  let dir = "";
  ({ gw, clock, dir } = openWith(adapter, ROUTE));
  const unhandled = await collectUnhandledRejections(async () => {
    const first = enqueue(gw, clock, ROUTE, "first").deliveryId;
    assert.equal(pending.length, 1, "reentrant enqueue must not start a second send");
    assert.equal(gw.store.getDelivery(second)?.status, "queued");
    gw.tick();
    gw.processOutbox();
    await flushAsync();
    assert.equal(pending.length, 1);
    pending[0]!.receipt.resolve({ receiptLevel: "accepted", providerMessageId: `p:${first}` });
    await flushAsync();
    assert.equal(pending.length, 2);
    pending[1]!.receipt.resolve({ receiptLevel: "accepted", providerMessageId: `p:${second}` });
    await flushAsync();
    gw.tick();
    gw.processOutbox();
    await flushAsync();
    assert.deepEqual(
      pending.map((p) => p.deliveryId),
      [first, second],
    );
    assert.equal(gw.store.getDelivery(first)?.status, "accepted");
    assert.equal(gw.store.getDelivery(second)?.status, "accepted");
  });
  assert.deepEqual(unhandled, []);
  assert.equal(track.maxInFlight, 1);
  gw.close();
  cleanup(dir);
});

test("send that synchronously kicks tick does not start a second drain over already queued deliveries", async () => {
  let gw!: Gateway;
  const { adapter, pending, track } = reentrantDeferredAdapter(() => {
    gw.tick();
  });
  const opened = openWith(adapter, ROUTE);
  gw = opened.gw;
  const { clock, dir } = opened;
  const unhandled = await collectUnhandledRejections(async () => {
    const ids = ["a", "b", "c"].map((text) => {
      const res = handle(
        gw,
        "delivery.enqueue",
        { route: ROUTE, text, notAfter: clock.nowMs() + 60_000, requireApproval: true },
        clock.nowMs(),
      );
      if (!res.ok) throw new Error(res.error.message);
      const id = (res.body as { deliveryId: string }).deliveryId;
      assert.equal(gw.approve(id).ok, true);
      return id;
    });
    gw.processOutbox();
    assert.equal(pending.length, 1, "reentrant tick must not start a second send");
    for (let i = 0; i < ids.length; i += 1) {
      await flushAsync();
      assert.equal(pending.length, i + 1);
      pending[i]!.receipt.resolve({ receiptLevel: "accepted", providerMessageId: `p:${ids[i]}` });
    }
    await flushAsync();
    assert.deepEqual(
      pending.map((p) => p.deliveryId),
      ids,
    );
    for (const id of ids) assert.equal(gw.store.getDelivery(id)?.status, "accepted");
  });
  assert.deepEqual(unhandled, []);
  assert.equal(track.maxInFlight, 1);
  gw.close();
  cleanup(dir);
});

test("synchronous send that enqueues another delivery still answers its receipt before the reentrant send", () => {
  let gw!: Gateway;
  let clock!: TestClock;
  const sent: string[] = [];
  let second = "";
  let firstStatusAtSecondSend = "";
  const adapter: SendAdapter = {
    manifest: plainManifest(),
    send(envelope) {
      sent.push(envelope.deliveryId);
      if (sent.length === 1) second = enqueue(gw, clock, ROUTE, "second").deliveryId;
      else firstStatusAtSecondSend = gw.store.getDelivery(sent[0]!)?.status ?? "";
      return { receiptLevel: "accepted", providerMessageId: `p:${envelope.deliveryId}` };
    },
  };
  let dir = "";
  ({ gw, clock, dir } = openWith(adapter, ROUTE));
  const body = enqueue(gw, clock, ROUTE, "first");
  assert.equal(body.status, "accepted");
  assert.deepEqual(sent, [body.deliveryId, second]);
  assert.equal(firstStatusAtSecondSend, "accepted");
  assert.equal(gw.store.getDelivery(second)?.status, "accepted");
  gw.close();
  cleanup(dir);
});
