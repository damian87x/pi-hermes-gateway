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

export type FakeAdapterConfig = { maxTextLength?: number; sinkPath?: string };

// Shape of config.adapter.config when this module is named by config.adapter.module. Anything the
// fake adapter does not understand is refused so a typo cannot silently drop the sink.
function parseFakeAdapterConfig(config: unknown): FakeAdapterConfig {
  if (config === null || config === undefined) return {};
  if (typeof config !== "object" || Array.isArray(config)) {
    throw new Error("fake adapter config must be an object");
  }
  const parsed: FakeAdapterConfig = {};
  for (const [key, value] of Object.entries(config as Record<string, unknown>)) {
    if (key === "sinkPath") {
      if (typeof value !== "string" || value.length === 0) throw new Error("fake adapter config sinkPath must be a non-empty string");
      parsed.sinkPath = value;
    } else if (key === "maxTextLength") {
      if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
        throw new Error("fake adapter config maxTextLength must be a positive integer");
      }
      parsed.maxTextLength = value;
    } else {
      throw new Error(`fake adapter config has unknown key ${JSON.stringify(key)}`);
    }
  }
  return parsed;
}

// Module-path factory for adapter-loader: config.adapter = { module: <this file>, config: { sinkPath } }.
export function createAdapter(config: unknown = null): FakeAdapter {
  return createFakeAdapter(parseFakeAdapterConfig(config));
}

export function createFakeAdapter(opts?: FakeAdapterConfig): FakeAdapter {
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
