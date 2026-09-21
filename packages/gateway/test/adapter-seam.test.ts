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
