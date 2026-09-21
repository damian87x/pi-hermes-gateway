import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { discardInbound } from "../dist/index.js";

test("inbound events are discarded without store, reply, or read-marking", () => {
  const sink = {
    stored: 0,
    replied: 0,
    readMarked: 0,
  };
  const event = {
    type: "messages.upsert",
    messages: [{ key: { remoteJid: "1001@s.whatsapp.net", id: "ABC" }, message: { conversation: "hello" } }],
  };
  const result = discardInbound(event, {
    store() {
      sink.stored += 1;
    },
    reply() {
      sink.replied += 1;
    },
    markRead() {
      sink.readMarked += 1;
    },
  });
  assert.equal(result.discarded, true);
  assert.equal(sink.stored, 0);
  assert.equal(sink.replied, 0);
  assert.equal(sink.readMarked, 0);
  assert.equal(JSON.stringify(result).includes("hello"), false);
});

test("discardInbound ignores missing hooks and does not persist the payload", () => {
  const result = discardInbound({ type: "messages.upsert", body: "secret-inbound" });
  assert.equal(result.discarded, true);
  assert.equal(JSON.stringify(result).includes("secret-inbound"), false);
});

test("source has no inbound store, reply, or read-marking", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "index.ts"), "utf8");
  assert.match(src, /discardInbound/);
  assert.equal(src.includes("sendReadReceipt"), false);
  assert.equal(src.includes("readMessages"), false);
  assert.equal(src.includes("chatModify"), false);
});
