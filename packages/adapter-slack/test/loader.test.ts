import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadSendAdapter } from "../../gateway/dist/adapter-loader.js";
import { openGateway } from "../../gateway/dist/index.js";

const slackModule = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

test("gateway loader loads slack", async () => {
  const adapter = await loadSendAdapter(
    slackModule,
    { kind: "bot-token", token: "xoxb-1234567890-ABCDEFtoken", timeoutMs: 20 },
    dirname(slackModule),
  );
  assert.equal(adapter.manifest.adapterId, "slack");
  assert.deepEqual(adapter.manifest.capabilities, ["send.text"]);
  assert.equal(typeof adapter.send, "function");
});

test("openGateway still defaults to fake when slack exists", async () => {
  const { Gateway, createFakeAdapter } = await import("../../gateway/dist/index.js");
  assert.equal(typeof Gateway, "function");
  const fake = createFakeAdapter();
  assert.equal(fake.manifest.adapterId, "fake");
  assert.equal(openGateway === undefined, false);
});
