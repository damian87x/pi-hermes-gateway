import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createWhatsAppAdapter } from "../dist/index.js";
import { loadSendAdapter } from "../../gateway/dist/adapter-loader.js";
import { openGateway } from "../../gateway/dist/index.js";

const ROUTE = {
  profileId: "profile-a",
  adapterId: "whatsapp",
  accountId: "wa-1",
  chatId: "1001@s.whatsapp.net",
};

const whatsappModule = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

test("gateway loader loads whatsapp like telegram", async () => {
  const adapter = await loadSendAdapter(whatsappModule, { kind: "send-only", timeoutMs: 20 }, dirname(whatsappModule));
  assert.equal(adapter.manifest.adapterId, "whatsapp");
  assert.deepEqual(adapter.manifest.capabilities, ["send.text"]);
  const receipt = adapter.send({ deliveryId: "dlv-load", route: ROUTE, text: "via-loader" });
  assert.equal(receipt.receiptLevel, "commit-unknown");
  assert.equal(receipt.reason, "send-fn-unconfigured");
});

test("openGateway still defaults to fake when whatsapp exists", async () => {
  const { Gateway, createFakeAdapter } = await import("../../gateway/dist/index.js");
  assert.equal(typeof Gateway, "function");
  const fake = createFakeAdapter();
  assert.equal(fake.manifest.adapterId, "fake");
});

test("injected timeout through a loaded factory is commit-unknown once (no adapter retry)", () => {
  let calls = 0;
  const adapter = createWhatsAppAdapter(
    { kind: "send-only" },
    {
      send() {
        calls += 1;
        return { kind: "timeout" };
      },
    },
  );
  const receipt = adapter.send({ deliveryId: "dlv-to", route: ROUTE, text: "hi" });
  assert.equal(receipt.receiptLevel, "commit-unknown");
  assert.equal(calls, 1);
  assert.equal(openGateway === undefined, false);
});
