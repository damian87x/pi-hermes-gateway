import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createAdapter, createSlackAdapter, parseBotTokenConfig } from "../dist/index.js";

const TOKEN = "xoxb-1234567890-ABCDEFtoken";
const ROUTE = {
  profileId: "profile-a",
  adapterId: "slack",
  accountId: "bot-1",
  chatId: "C1001",
};

function srcFiles(): string[] {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
  return ["index.ts"].map((name) => readFileSync(join(root, name), "utf8"));
}

function pkgJson(): Record<string, unknown> {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  return JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, unknown>;
}

test("bot-token config only; invalid token is not echoed", () => {
  assert.throws(() => parseBotTokenConfig({ kind: "socket-mode", token: TOKEN }), /bot-token/);
  try {
    parseBotTokenConfig({ kind: "bot-token", token: "nope/events" });
    assert.ok(false, "expected throw");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    assert.equal(message.includes("nope"), false);
    assert.equal(message.includes("events"), false);
  }
});

test("origin policy rejects non-loopback HTTP before posting and permits HTTPS or exact loopback", () => {
  const deniedOrigins = ["http://slack.com", "http://10.0.0.12:8080", "http://127.0.0.1.attacker.test"];
  for (const apiOrigin of deniedOrigins) {
    let calls = 0;
    assert.throws(
      () => createSlackAdapter(
        { kind: "bot-token", token: TOKEN, apiOrigin },
        { post() { calls += 1; return { kind: "ok", status: 200, json: { ok: true, ts: "1.0" } }; } },
      ),
      (err: unknown) => {
        assert.equal((err instanceof Error ? err.message : String(err)).includes(TOKEN), false);
        return true;
      },
    );
    assert.equal(calls, 0, apiOrigin);
  }

  for (const apiOrigin of ["https://slack.com", "http://127.0.0.1", "http://127.0.0.1:8080"]) {
    const calls: string[] = [];
    const adapter = createSlackAdapter(
      { kind: "bot-token", token: TOKEN, apiOrigin },
      { post(req) { calls.push(req.url); return { kind: "ok", status: 200, json: { ok: true, ts: "1.0" } }; } },
    );
    assert.equal(adapter.send({ deliveryId: "origin-policy", route: ROUTE, text: "hi" }).receiptLevel, "accepted");
    assert.deepEqual(calls, [`${apiOrigin}/api/chat.postMessage`]);
  }
});

test("mock chat.postMessage success returns accepted provider id", () => {
  const calls: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
  const adapter = createSlackAdapter(
    { kind: "bot-token", token: TOKEN },
    {
      post(req: { url: string; method: string; body: Record<string, unknown> }) {
        calls.push({ url: req.url, method: req.method, body: req.body });
        return { kind: "ok", status: 200, json: { ok: true, ts: "1405894322.002768" } };
      },
    },
  );
  const receipt = adapter.send({ deliveryId: "dlv-1", route: ROUTE, text: "hi" });
  assert.equal(receipt.receiptLevel, "accepted");
  assert.equal(receipt.providerMessageId, "1405894322.002768");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, "chat.postMessage");
  assert.match(calls[0]?.url ?? "", /\/api\/chat\.postMessage$/);
  assert.equal(calls[0]?.url.includes("slack.com"), true);
  assert.equal(calls[0]?.url.includes(TOKEN), false);
  assert.deepEqual(calls[0]?.body, { channel: "C1001", text: "hi" });
});

test("HTTP 500 with ok:true body is commit-unknown, not accepted", () => {
  const adapter = createSlackAdapter(
    { kind: "bot-token", token: TOKEN },
    {
      post() {
        return { kind: "ok", status: 500, json: { ok: true, ts: "1405894322.002768" } };
      },
    },
  );
  const receipt = adapter.send({ deliveryId: "dlv-500", route: ROUTE, text: "hi" });
  assert.equal(receipt.receiptLevel, "commit-unknown");
  assert.equal(receipt.providerMessageId, undefined);
});

test("2xx ok:true with missing ts is commit-unknown, not the deliveryId", () => {
  const adapter = createSlackAdapter(
    { kind: "bot-token", token: TOKEN },
    {
      post() {
        return { kind: "ok", status: 200, json: { ok: true } };
      },
    },
  );
  const receipt = adapter.send({ deliveryId: "dlv-missing-id", route: ROUTE, text: "hi" });
  assert.equal(receipt.receiptLevel, "commit-unknown");
  assert.equal(receipt.providerMessageId, undefined);
});

test("2xx ok:true with invalid ts is commit-unknown", () => {
  const adapter = createSlackAdapter(
    { kind: "bot-token", token: TOKEN },
    {
      post() {
        return { kind: "ok", status: 200, json: { ok: true, ts: "" } };
      },
    },
  );
  const receipt = adapter.send({ deliveryId: "dlv-empty-id", route: ROUTE, text: "hi" });
  assert.equal(receipt.receiptLevel, "commit-unknown");
  assert.equal(receipt.providerMessageId, undefined);
});

test("2xx with body error (ok:false) is commit-unknown", () => {
  const adapter = createSlackAdapter(
    { kind: "bot-token", token: TOKEN },
    {
      post() {
        return { kind: "ok", status: 200, json: { ok: false, error: "channel_not_found" } };
      },
    },
  );
  const receipt = adapter.send({ deliveryId: "dlv-body-error", route: ROUTE, text: "hi" });
  assert.equal(receipt.receiptLevel, "commit-unknown");
  assert.equal(receipt.providerMessageId, undefined);
});

test("mock chat.postMessage timeout is commit-unknown", () => {
  let calls = 0;
  const adapter = createAdapter(
    { kind: "bot-token", token: TOKEN, timeoutMs: 5 },
    {
      post() {
        calls += 1;
        return { kind: "timeout" };
      },
    },
  );
  const receipt = adapter.send({ deliveryId: "dlv-2", route: ROUTE, text: "hi" });
  assert.equal(receipt.receiptLevel, "commit-unknown");
  assert.equal(receipt.reason, "timeout");
  const again = adapter.send({ deliveryId: "dlv-2b", route: ROUTE, text: "hi" });
  assert.equal(again.receiptLevel, "commit-unknown");
  assert.equal(calls, 2);
});

test("thrown HTTP errors redact the token and stay commit-unknown", () => {
  const adapter = createSlackAdapter(
    { kind: "bot-token", token: TOKEN },
    {
      post(req: { url: string }) {
        throw new Error(`upstream ${req.url} token=${TOKEN}`);
      },
    },
  );
  const receipt = adapter.send({ deliveryId: "dlv-3", route: ROUTE, text: "hi" });
  assert.equal(receipt.receiptLevel, "commit-unknown");
  assert.equal(receipt.reason?.includes(TOKEN), false);
  assert.equal(receipt.reason?.includes("<redacted>"), true);
});

test("source never mentions Events API or Socket Mode", () => {
  for (const src of srcFiles()) {
    assert.equal(/events.?api/i.test(src), false);
    assert.equal(/socket.?mode/i.test(src), false);
    assert.equal(src.includes("event_callback"), false);
    assert.equal(src.includes("rtm.start"), false);
  }
});

test("createAdapter is a structural send adapter", () => {
  const adapter = createAdapter({ kind: "bot-token", token: TOKEN });
  assert.equal(adapter.manifest.adapterId, "slack");
  assert.deepEqual(adapter.manifest.capabilities, ["send.text"]);
  assert.equal(typeof adapter.send, "function");
  const receipt = adapter.send({ deliveryId: "dlv-4", route: ROUTE, text: "hi" });
  assert.equal(receipt.receiptLevel, "commit-unknown");
  assert.equal(receipt.reason, "http-client-unconfigured");
});

test("package is private npm-only with no pi key", () => {
  const pkg = pkgJson();
  assert.equal(pkg.private, true);
  assert.equal(pkg.pi, undefined);
  assert.equal(pkg.peerDependencies, undefined);
});
