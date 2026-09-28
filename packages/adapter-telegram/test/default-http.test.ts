import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  createTelegramAdapter,
  defaultTelegramHttpPost,
  parseDedicatedBotConfig,
} from "../dist/index.js";
import { loadSendAdapter } from "../../gateway/dist/adapter-loader.js";

const TOKEN = "123456:ABC-DEF_token";
const ROUTE = {
  profileId: "profile-a",
  adapterId: "telegram",
  accountId: "bot-1",
  chatId: "1001",
};

const telegramModule = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

type Recorded = { method?: string; url?: string; body: string };

function listen(
  onRequest: (req: IncomingMessage, res: ServerResponse, recorded: Recorded[]) => void,
): Promise<{ origin: string; server: Server; recorded: Recorded[] }> {
  const recorded: Recorded[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      recorded.push({ method: req.method, url: req.url, body });
      onRequest(req, res, recorded);
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("expected tcp address"));
        return;
      }
      resolve({ origin: `http://127.0.0.1:${addr.port}`, server, recorded });
    });
    server.on("error", reject);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

test("apiOrigin is used instead of api.telegram.org", () => {
  const config = parseDedicatedBotConfig({
    kind: "dedicated-bot",
    token: TOKEN,
    apiOrigin: "http://127.0.0.1:9",
  });
  assert.equal(config.apiOrigin, "http://127.0.0.1:9");
  const urls: string[] = [];
  const adapter = createTelegramAdapter(config, {
    post(req) {
      urls.push(req.url);
      return { kind: "ok", status: 200, json: { ok: true, result: { message_id: 1 } } };
    },
  });
  const receipt = adapter.send({ deliveryId: "dlv-origin", route: ROUTE, text: "hi" });
  assert.equal(receipt.receiptLevel, "accepted");
  assert.equal(urls[0]?.includes("api.telegram.org"), false);
  assert.equal(urls[0]?.startsWith("http://127.0.0.1:9/bot"), true);
  assert.match(urls[0] ?? "", /\/sendMessage$/);
});

test("default post mock 200 + message_id is accepted and does not retry", async () => {
  const started = await listen((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, result: { message_id: 42 } }));
  });
  try {
    const url = `${started.origin}/bot${TOKEN}/sendMessage`;
    const result = await defaultTelegramHttpPost({
      method: "sendMessage",
      url,
      body: { chat_id: "1001", text: "hi" },
      timeoutMs: 500,
    });
    assert.equal(result.kind, "ok");
    if (result.kind !== "ok") throw new Error("expected ok");
    assert.equal(result.status, 200);
    assert.deepEqual(result.json, { ok: true, result: { message_id: 42 } });
    const adapter = createTelegramAdapter(
      { kind: "dedicated-bot", token: TOKEN, timeoutMs: 500, apiOrigin: started.origin },
      { post: defaultTelegramHttpPost },
    );
    const receipt = await adapter.send({ deliveryId: "dlv-ok", route: ROUTE, text: "hi" });
    assert.equal(receipt.receiptLevel, "accepted");
    assert.equal(receipt.providerMessageId, "42");
    assert.equal(JSON.stringify(receipt).includes(TOKEN), false);
    assert.equal(started.recorded.length, 2);
    assert.equal(started.recorded[0]?.method, "POST");
    assert.equal(started.recorded[0]?.url?.includes("getUpdates"), false);
    assert.equal(started.recorded[1]?.body.includes("hi"), true);
  } finally {
    await closeServer(started.server);
  }
});

test("default post timeout/abort is commit-unknown with no retry and no token", async () => {
  const started = await listen(() => {
    /* hang until client abort */
  });
  try {
    const result = await defaultTelegramHttpPost({
      method: "sendMessage",
      url: `${started.origin}/bot${TOKEN}/sendMessage`,
      body: { chat_id: "1001", text: "hi" },
      timeoutMs: 40,
    });
    assert.equal(result.kind, "timeout");
    const adapter = createTelegramAdapter(
      { kind: "dedicated-bot", token: TOKEN, timeoutMs: 40, apiOrigin: started.origin },
      { post: defaultTelegramHttpPost },
    );
    const receipt = await adapter.send({ deliveryId: "dlv-to", route: ROUTE, text: "hi" });
    assert.equal(receipt.receiptLevel, "commit-unknown");
    assert.equal(receipt.reason, "timeout");
    assert.equal(receipt.reason?.includes(TOKEN), false);
    assert.equal(JSON.stringify(receipt).includes(TOKEN), false);
    assert.equal(started.recorded.length, 2);
  } finally {
    started.server.closeAllConnections();
    await closeServer(started.server);
  }
});

test("loader supplies default post so telegram send hits the local mock server", async () => {
  const started = await listen((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, result: { message_id: 9 } }));
  });
  try {
    const adapter = await loadSendAdapter(
      telegramModule,
      { kind: "dedicated-bot", token: TOKEN, timeoutMs: 500, apiOrigin: started.origin },
      dirname(telegramModule),
    );
    const receipt = await adapter.send({ deliveryId: "dlv-load", route: ROUTE, text: "via-loader" });
    assert.equal(receipt.receiptLevel, "accepted");
    assert.equal(receipt.providerMessageId, "9");
    assert.equal(started.recorded.length, 1);
    assert.equal(started.recorded[0]?.method, "POST");
    assert.match(started.recorded[0]?.url ?? "", /\/sendMessage$/);
    assert.equal(started.recorded[0]?.url?.includes("api.telegram.org"), false);
    assert.equal(JSON.stringify(receipt).includes(TOKEN), false);
  } finally {
    await closeServer(started.server);
  }
});
