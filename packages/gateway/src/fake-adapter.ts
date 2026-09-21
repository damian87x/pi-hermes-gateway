import {
  ADAPTER_API_VERSION,
  LIMITS,
  validateAdapterManifest,
} from "pi-hermes-gateway-protocol";
import { writeFileSync } from "node:fs";
import type { SendAdapter, SendEnvelope } from "./adapter.js";

export type FakeSendEnvelope = SendEnvelope;

export type FakeReceipt = {
  receiptLevel: "accepted";
  providerMessageId: string;
};

export type FakeAdapter = SendAdapter & {
  sent: FakeSendEnvelope[];
  crashMidSend: boolean;
  sinkPath: string | null;
  send(envelope: FakeSendEnvelope): FakeReceipt;
};

export function createFakeAdapter(opts?: { maxTextLength?: number; sinkPath?: string }): FakeAdapter {
  // protocol caller: validateAdapterManifest — fake adapter construction (Gateway.open / createFakeAdapter)
  const manifestResult = validateAdapterManifest({
    adapterId: "fake",
    adapterApiVersion: ADAPTER_API_VERSION,
    capabilities: ["send.text"],
    configSchemaVersion: 1,
    maxTextLength: opts?.maxTextLength ?? LIMITS.maxTextChars,
    receiptLevels: ["accepted"],
  });
  if (!manifestResult.ok) throw new Error(`fake adapter manifest invalid: ${manifestResult.error.message}`);
  const sent: FakeSendEnvelope[] = [];
  const adapter: FakeAdapter = {
    manifest: manifestResult.value,
    sent,
    crashMidSend: false,
    sinkPath: opts?.sinkPath ?? null,
    send(envelope: FakeSendEnvelope): FakeReceipt {
      if (adapter.crashMidSend) {
        adapter.crashMidSend = false;
        throw new Error("injected mid-send crash");
      }
      if (envelope.text.length > adapter.manifest.maxTextLength) {
        throw new Error("text exceeds adapter maxTextLength");
      }
      sent.push({ ...envelope, route: { ...envelope.route } });
      if (adapter.sinkPath) {
        writeFileSync(adapter.sinkPath, `${JSON.stringify(sent)}\n`);
      }
      return { receiptLevel: "accepted", providerMessageId: `fake:${envelope.deliveryId}` };
    },
  };
  return adapter;
}
