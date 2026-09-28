import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createAdapter, createTelegramAdapter, parseDedicatedBotConfig } from "../dist/index.js";

const TOKEN = "123456:ABC-DEF_token";
const ROUTE = {
  profileId: "profile-a",
  adapterId: "telegram",
  accountId: "bot-1",
  chatId: "1001",
};

function srcFiles(): string[] {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
  return ["index.ts"].map((name) => readFileSync(join(root, name), "utf8"));
}

test("dedicated-bot config only; invalid token is not echoed", () => {
  assert.throws(() => parseDedicatedBotConfig({ kind: "shared-token", token: TOKEN }), /dedicated-bot/);
  try {
    parseDedicatedBotConfig({ kind: "dedicated-bot", token: "nope/getUpdates" });
    assert.ok(false, "expected throw");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    assert.equal(message.includes("nope"), false);
    assert.equal(message.includes("getUpdates"), false);
  }
});

test("mock sendMessage success returns accepted provider id", () => {
  const calls: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
  const adapter = createTelegramAdapter(
    { kind: "dedicated-bot", token: TOKEN },
    {
      post(req) {
        calls.push({ url: req.url, method: req.method, body: req.body });
        return { kind: "ok", status: 200, json: { ok: true, result: { message_id: 77 } } };
      },
    },
  );
  const receipt = adapter.send({ deliveryId: "dlv-1", route: ROUTE, text: "hi" });
  assert.equal(receipt.receiptLevel, "accepted");
  assert.equal(receipt.providerMessageId, "77");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, "sendMessage");
  assert.match(calls[0]?.url ?? "", /\/sendMessage$/);
  assert.equal(calls[0]?.url.includes("getUpdates"), false);
  assert.equal(calls[0]?.url.includes("setWebhook"), false);
  assert.deepEqual(calls[0]?.body, { chat_id: "1001", text: "hi" });
});

test("HTTP 500 with ok:true body is commit-unknown, not accepted", () => {
  const adapter = createTelegramAdapter(
    { kind: "dedicated-bot", token: TOKEN },
    {
      post() {
        return { kind: "ok", status: 500, json: { ok: true, result: { message_id: 77 } } };
      },
    },
  );
  const receipt = adapter.send({ deliveryId: "dlv-500", route: ROUTE, text: "hi" });
  assert.equal(receipt.receiptLevel, "commit-unknown");
  assert.equal(receipt.providerMessageId, undefined);
});

test("2xx ok:true with missing message_id is commit-unknown, not the deliveryId", () => {
  const adapter = createTelegramAdapter(
    { kind: "dedicated-bot", token: TOKEN },
    {
      post() {
        return { kind: "ok", status: 200, json: { ok: true, result: {} } };
      },
    },
  );
  const receipt = adapter.send({ deliveryId: "dlv-missing-id", route: ROUTE, text: "hi" });
  assert.equal(receipt.receiptLevel, "commit-unknown");
  assert.equal(receipt.providerMessageId, undefined);
});

test("2xx ok:true with invalid message_id is commit-unknown", () => {
  for (const message_id of ["", 0, -1, 1.5, "0", " 0 "]) {
    const adapter = createTelegramAdapter(
      { kind: "dedicated-bot", token: TOKEN },
      {
        post() {
          return { kind: "ok", status: 200, json: { ok: true, result: { message_id } } };
        },
      },
    );
    const receipt = adapter.send({ deliveryId: "dlv-empty-id", route: ROUTE, text: "hi" });
    assert.equal(receipt.receiptLevel, "commit-unknown", String(message_id));
    assert.equal(receipt.providerMessageId, undefined);
  }
});

test("2xx with body error (ok:false) is commit-unknown", () => {
  const adapter = createTelegramAdapter(
    { kind: "dedicated-bot", token: TOKEN },
    {
      post() {
        return { kind: "ok", status: 200, json: { ok: false, description: "Bad Request" } };
      },
    },
  );
  const receipt = adapter.send({ deliveryId: "dlv-body-error", route: ROUTE, text: "hi" });
  assert.equal(receipt.receiptLevel, "commit-unknown");
  assert.equal(receipt.providerMessageId, undefined);
});

test("mock sendMessage timeout is commit-unknown", () => {
  const adapter = createAdapter(
    { kind: "dedicated-bot", token: TOKEN, timeoutMs: 5 },
    {
      post() {
        return { kind: "timeout" };
      },
    },
  );
  const receipt = adapter.send({ deliveryId: "dlv-2", route: ROUTE, text: "hi" });
  assert.equal(receipt.receiptLevel, "commit-unknown");
  assert.equal(receipt.reason, "timeout");
});

test("thrown HTTP errors redact the token and stay commit-unknown", () => {
  const adapter = createTelegramAdapter(
    { kind: "dedicated-bot", token: TOKEN },
    {
      post(req) {
        throw new Error(`upstream ${req.url}`);
      },
    },
  );
  const receipt = adapter.send({ deliveryId: "dlv-3", route: ROUTE, text: "hi" });
  assert.equal(receipt.receiptLevel, "commit-unknown");
  assert.equal(receipt.reason?.includes(TOKEN), false);
  assert.equal(receipt.reason?.includes("<redacted>"), true);
});

test("source never mentions getUpdates or setWebhook", () => {
  for (const src of srcFiles()) {
    assert.equal(src.includes("getUpdates"), false);
    assert.equal(src.includes("setWebhook"), false);
  }
});

test("createAdapter is a structural send adapter", () => {
  const adapter = createAdapter({ kind: "dedicated-bot", token: TOKEN });
  assert.equal(adapter.manifest.adapterId, "telegram");
  assert.equal(typeof adapter.send, "function");
  const receipt = adapter.send({ deliveryId: "dlv-4", route: ROUTE, text: "hi" });
  assert.equal(receipt.receiptLevel, "commit-unknown");
  assert.equal(receipt.reason, "http-client-unconfigured");
});
