import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  ADAPTER_API_VERSION,
  LIMITS,
  validateAdapterManifest,
} from "pi-hermes-gateway-protocol";
import { loadSendAdapter } from "../dist/adapter-loader.js";
import { isSendAdapter } from "../dist/adapter.js";
import { openGateway } from "../dist/index.js";
import { cleanup, handle, openTestGw, ROUTE, tmpDir } from "./helpers.ts";

const PLAIN_ROUTE = { ...ROUTE, adapterId: "plain" };

function plainAdapter(sent: string[], adapterId = "plain") {
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
    routes: [PLAIN_ROUTE],
    adapter,
  });
  const res = handle(
    opened.gateway,
    "delivery.enqueue",
    { route: PLAIN_ROUTE, text: "hello", notAfter: clock.nowMs() + 60_000 },
    clock.nowMs(),
  );
  assert.equal(res.ok, true);
  assert.equal(sent.length, 1);
  opened.gateway.close();
  cleanup(dir);
});

test("route adapterId must match the loaded adapter manifest before enqueue, job and dispatch", () => {
  const dir = tmpDir();
  const { gw, clock } = openTestGw({ dir });
  gw.close();
  const sent: string[] = [];
  const opened = openGateway({
    dbPath: join(dir, "telegram.sqlite"),
    clock,
    routes: [ROUTE],
    adapter: plainAdapter(sent, "telegram"),
  });
  const store = opened.gateway.store;
  const enq = handle(
    opened.gateway,
    "delivery.enqueue",
    { route: ROUTE, text: "hello", notAfter: clock.nowMs() + 60_000 },
    clock.nowMs(),
  );
  assert.equal(enq.ok, false);
  assert.equal(enq.ok ? undefined : enq.error.code, "invalid_route");
  assert.equal(store.listDeliveries().length, 0);
  const job = handle(
    opened.gateway,
    "job.create",
    {
      kind: "static-text",
      text: "slot",
      route: ROUTE,
      schedule: { type: "daily", localTime: "12:00", timeZone: "UTC" },
    },
    clock.nowMs(),
  );
  assert.equal(job.ok, false);
  assert.equal(job.ok ? undefined : job.error.code, "invalid_route");
  assert.equal(store.listJobs().length, 0);
  store.insertDelivery({
    delivery_id: "dlv_mismatch",
    job_id: null,
    occurrence_id: null,
    source: "enqueue",
    route_json: JSON.stringify(ROUTE),
    text: "queued",
    not_after_ms: clock.nowMs() + 60_000,
    status: "queued",
    request_id: null,
    created_at_ms: clock.nowMs(),
    dispatch_intent: 0,
  });
  opened.gateway.processOutbox();
  assert.equal(store.getDelivery("dlv_mismatch")?.status, "failed");
  assert.equal(store.getDelivery("dlv_mismatch")?.dispatch_intent, 0);
  store.insertJob({
    job_id: "job_mismatch",
    kind: "static-text",
    text: "slot",
    route_json: JSON.stringify(ROUTE),
    schedule_json: JSON.stringify({ type: "daily", localTime: "10:00", timeZone: "UTC" }),
    status: "active",
    created_at_ms: clock.nowMs() - 60_000,
    watermark_ms: clock.nowMs() - 60_000,
  });
  opened.gateway.tick();
  assert.deepEqual(
    store.listOccurrences("job_mismatch").map((occ) => occ.status),
    ["skipped"],
  );
  assert.equal(store.listDeliveries().length, 1);
  assert.equal(sent.length, 0);
  opened.gateway.close();
  cleanup(dir);
});

test("custom adapter dispatches routes carrying its own adapterId", () => {
  const dir = tmpDir();
  const { gw, clock } = openTestGw({ dir });
  gw.close();
  const sent: string[] = [];
  const telegramRoute = { ...ROUTE, adapterId: "telegram" };
  const opened = openGateway({
    dbPath: join(dir, "telegram.sqlite"),
    clock,
    routes: [telegramRoute],
    adapter: plainAdapter(sent, "telegram"),
  });
  const res = handle(
    opened.gateway,
    "delivery.enqueue",
    { route: telegramRoute, text: "hello", notAfter: clock.nowMs() + 60_000 },
    clock.nowMs(),
  );
  assert.equal(res.ok, true);
  assert.equal(sent.length, 1);
  assert.equal(opened.gateway.store.listDeliveries()[0]?.status, "accepted");
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
    routes: [PLAIN_ROUTE],
    adapter,
  });
  handle(
    opened.gateway,
    "delivery.enqueue",
    { route: PLAIN_ROUTE, text: "hello", notAfter: clock.nowMs() + 60_000 },
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

test("unconfirmed adapter receipt (async/malformed) is commit-unknown, never accepted", () => {
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
  const receipts: unknown[] = [new Promise(() => {}), {}, undefined];
  const adapter = {
    manifest: manifestResult.value,
    send() {
      return receipts.shift() as { receiptLevel: "accepted" };
    },
  };
  const opened = openGateway({
    dbPath: join(dir, "unconfirmed.sqlite"),
    clock,
    routes: [PLAIN_ROUTE],
    adapter,
  });
  for (const text of ["a", "b", "c"]) {
    handle(opened.gateway, "delivery.enqueue", { route: PLAIN_ROUTE, text, notAfter: clock.nowMs() + 60_000 }, clock.nowMs());
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
