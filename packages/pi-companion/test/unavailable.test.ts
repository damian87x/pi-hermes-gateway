import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  companionEnqueue,
  companionJobCreate,
  companionStatus,
  daemonAvailable,
  resolveProfileDir,
} from "../dist/index.js";
import gatewayCompanion from "../dist/extension.js";

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

test("importing companion does not start a daemon or mention Telegram transport", () => {
  assert.equal(daemonAvailable("/no/such/hermes-profile"), false);
  const sources = ["client.ts", "extension.ts", "index.ts"].map((name) => readFileSync(join(srcDir, name), "utf8"));
  for (const src of sources) {
    assert.equal(src.includes("getUpdates"), false);
    assert.equal(src.includes("setWebhook"), false);
    assert.equal(src.includes("api.telegram.org"), false);
    assert.equal(/spawn\(|fork\(|execFile\(/.test(src), false);
  }
});

test("status and enqueue without a daemon report unavailable and start nothing", async () => {
  const missing = join("/tmp", "pi-hermes-missing-profile-s2s3");
  const status = await companionStatus(missing);
  assert.equal(status.ok, false);
  if (!status.ok) assert.equal(status.error.code, "daemon-unavailable");
  const enq = await companionEnqueue(missing, {
    route: { profileId: "p", adapterId: "fake", accountId: "a", chatId: "c" },
    text: "x",
    notAfter: Date.now() + 60_000,
  });
  assert.equal(enq.ok, false);
  if (!enq.ok) assert.equal(enq.error.code, "daemon-unavailable");
  const job = await companionJobCreate(missing, { kind: "static-text" });
  assert.equal(job.ok, false);
});

test("session_start does not start a daemon or open Telegram", async () => {
  const events: string[] = [];
  const tools: string[] = [];
  gatewayCompanion({
    on(event, handler) {
      events.push(event);
      if (event === "session_start") {
        void handler();
      }
    },
    registerTool(tool) {
      tools.push(tool.name);
    },
  });
  assert.equal(events.includes("session_start"), true);
  assert.equal(tools.includes("gateway_status"), true);
  assert.equal(tools.includes("gateway_enqueue"), true);
  assert.equal(resolveProfileDir({}), "");
  assert.equal(daemonAvailable(""), false);
});
