import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createAdapter, createWhatsAppAdapter, parseSendOnlyConfig } from "../dist/index.js";

const SECRET = "sess_live_do_not_log";
const ROUTE = {
  profileId: "profile-a",
  adapterId: "whatsapp",
  accountId: "wa-1",
  chatId: "1001@s.whatsapp.net",
};

function srcFiles(): string[] {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
  return ["index.ts"].map((name) => readFileSync(join(root, name), "utf8"));
}

function pkgJson(): Record<string, unknown> {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  return JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, unknown>;
}

test("send-only config only; secrets and auth dirs are not echoed", () => {
  assert.throws(() => parseSendOnlyConfig({ kind: "baileys-socket", authDir: "/home/user/.wa-auth" }), /send-only/);
  try {
    parseSendOnlyConfig({ kind: "send-only", sessionSecret: "bad secret", authDir: "/var/lib/wa" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    assert.equal(message.includes("bad secret"), false);
    assert.equal(message.includes("/var/lib/wa"), false);
    assert.equal(message.includes("authDir"), false);
  }
  const config = parseSendOnlyConfig({ kind: "send-only", timeoutMs: 7, sessionSecret: SECRET });
  assert.equal(config.kind, "send-only");
  assert.equal(config.timeoutMs, 7);
});

test("injected send success returns accepted provider id", () => {
  const calls: Array<{ jid: string; text: string; timeoutMs: number }> = [];
  const adapter = createWhatsAppAdapter(
    { kind: "send-only", timeoutMs: 50 },
    {
      send(req) {
        calls.push({ jid: req.jid, text: req.text, timeoutMs: req.timeoutMs });
        return { kind: "ok", providerMessageId: "wamid.77" };
      },
    },
  );
  const receipt = adapter.send({ deliveryId: "dlv-1", route: ROUTE, text: "hi" });
  assert.equal(receipt.receiptLevel, "accepted");
  assert.equal(receipt.providerMessageId, "wamid.77");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.jid, ROUTE.chatId);
  assert.equal(calls[0]?.text, "hi");
  assert.equal(calls[0]?.timeoutMs, 50);
});

test("injected send timeout is commit-unknown with no retry", () => {
  let calls = 0;
  const adapter = createAdapter(
    { kind: "send-only", timeoutMs: 5 },
    {
      send() {
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

test("unknown send is commit-unknown", () => {
  const adapter = createWhatsAppAdapter(
    { kind: "send-only" },
    {
      send() {
        return { kind: "unknown" };
      },
    },
  );
  const receipt = adapter.send({ deliveryId: "dlv-3", route: ROUTE, text: "hi" });
  assert.equal(receipt.receiptLevel, "commit-unknown");
  assert.equal(receipt.reason, "whatsapp-send-unconfirmed");
});

test("thrown send errors redact session secrets and stay commit-unknown", () => {
  const adapter = createWhatsAppAdapter(
    { kind: "send-only", sessionSecret: SECRET },
    {
      send(req) {
        throw new Error(`socket ${SECRET} jid=${req.jid}`);
      },
    },
  );
  const receipt = adapter.send({ deliveryId: "dlv-4", route: ROUTE, text: "hi" });
  assert.equal(receipt.receiptLevel, "commit-unknown");
  assert.equal(receipt.reason?.includes(SECRET), false);
  assert.equal(receipt.reason?.includes("<redacted>"), true);
  assert.equal(JSON.stringify(receipt).includes(SECRET), false);
});

test("createAdapter is a structural send adapter without a live socket", () => {
  const adapter = createAdapter({ kind: "send-only" });
  assert.equal(adapter.manifest.adapterId, "whatsapp");
  assert.deepEqual(adapter.manifest.capabilities, ["send.text"]);
  assert.equal(typeof adapter.send, "function");
  const receipt = adapter.send({ deliveryId: "dlv-5", route: ROUTE, text: "hi" });
  assert.equal(receipt.receiptLevel, "commit-unknown");
  assert.equal(receipt.reason, "send-fn-unconfigured");
});

test("package is private npm-only and source never opens Baileys or an auth dir", () => {
  const pkg = pkgJson();
  assert.equal(pkg.private, true);
  assert.equal(pkg.pi, undefined);
  assert.equal(pkg.peerDependencies, undefined);
  const deps = (pkg.dependencies ?? {}) as Record<string, unknown>;
  assert.equal("baileys" in deps, false);
  assert.equal("@whiskeysockets/baileys" in deps, false);
  for (const src of srcFiles()) {
    assert.equal(/baileys/i.test(src), false);
    assert.equal(src.includes("makeWASocket"), false);
    assert.equal(src.includes("useMultiFileAuthState"), false);
    assert.equal(/authDir/i.test(src), false);
    assert.equal(/\bQR\b/i.test(src), false);
    assert.equal(/pair(ing)?/i.test(src), false);
    assert.equal(src.includes("sendReadReceipt"), false);
    assert.equal(src.includes("readMessages"), false);
  }
});
