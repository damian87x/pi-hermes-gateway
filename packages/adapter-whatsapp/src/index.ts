import {
  ADAPTER_API_VERSION,
  LIMITS,
  validateAdapterManifest,
  type AdapterManifest,
  type DeliveryRoute,
} from "pi-hermes-gateway-protocol";

export type WhatsAppSendOnlyConfig = {
  kind: "send-only";
  timeoutMs: number;
  sessionSecret?: string;
};

export type WhatsAppSendRequest = {
  jid: string;
  text: string;
  timeoutMs: number;
};

export type WhatsAppSendResult =
  | { kind: "ok"; providerMessageId?: string }
  | { kind: "timeout" }
  | { kind: "unknown" };

export type WhatsAppSendFn = (
  request: WhatsAppSendRequest,
) => WhatsAppSendResult | Promise<WhatsAppSendResult>;

export type WhatsAppSendEnvelope = {
  deliveryId: string;
  route: DeliveryRoute;
  text: string;
};

export type WhatsAppSendReceipt = {
  receiptLevel: "accepted" | "commit-unknown";
  providerMessageId?: string;
  reason?: string;
};

export type WhatsAppAdapter = {
  manifest: AdapterManifest;
  send(envelope: WhatsAppSendEnvelope): WhatsAppSendReceipt | Promise<WhatsAppSendReceipt>;
};

export type InboundHooks = {
  store?: () => void;
  reply?: () => void;
  markRead?: () => void;
};

const DEFAULT_TIMEOUT_MS = 10_000;
const ALLOWED_CONFIG_KEYS = new Set(["kind", "timeoutMs", "sessionSecret"]);

function redact(text: string, secret: string | undefined): string {
  if (!secret) return text;
  return text.split(secret).join("<redacted>");
}

function isThenable<T>(value: unknown): value is Promise<T> {
  return typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function";
}

export function parseSendOnlyConfig(input: unknown): WhatsAppSendOnlyConfig {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("whatsapp config must be a send-only object");
  }
  const rec = input as { kind?: unknown; timeoutMs?: unknown; sessionSecret?: unknown };
  if (rec.kind !== "send-only") {
    throw new Error("whatsapp config kind must be send-only");
  }
  for (const key of Object.keys(rec)) {
    if (!ALLOWED_CONFIG_KEYS.has(key)) {
      throw new Error("whatsapp config is invalid");
    }
  }
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (rec.timeoutMs !== undefined) {
    if (typeof rec.timeoutMs !== "number" || !Number.isInteger(rec.timeoutMs) || rec.timeoutMs < 1) {
      throw new Error("timeoutMs must be a positive integer");
    }
    timeoutMs = rec.timeoutMs;
  }
  const parsed: WhatsAppSendOnlyConfig = { kind: "send-only", timeoutMs };
  if (rec.sessionSecret !== undefined) {
    if (typeof rec.sessionSecret !== "string" || rec.sessionSecret.length === 0) {
      throw new Error("sessionSecret is invalid");
    }
    parsed.sessionSecret = rec.sessionSecret;
  }
  return parsed;
}

function receiptFromResult(result: WhatsAppSendResult, deliveryId: string): WhatsAppSendReceipt {
  if (result.kind === "timeout") {
    return { receiptLevel: "commit-unknown", reason: "timeout" };
  }
  if (result.kind === "ok") {
    const id = result.providerMessageId;
    const providerMessageId = typeof id === "string" && id.length > 0 ? id : deliveryId;
    return { receiptLevel: "accepted", providerMessageId };
  }
  return { receiptLevel: "commit-unknown", reason: "whatsapp-send-unconfirmed" };
}

export function discardInbound(_event: unknown, _hooks?: InboundHooks): { discarded: true } {
  return { discarded: true };
}

export function createWhatsAppAdapter(
  configInput: unknown,
  deps?: { send: WhatsAppSendFn },
): WhatsAppAdapter {
  const config = parseSendOnlyConfig(configInput);
  const manifestResult = validateAdapterManifest({
    adapterId: "whatsapp",
    adapterApiVersion: ADAPTER_API_VERSION,
    capabilities: ["send.text"],
    configSchemaVersion: 1,
    maxTextLength: LIMITS.maxTextChars,
    receiptLevels: ["accepted"],
  });
  if (!manifestResult.ok) throw new Error(`whatsapp adapter manifest invalid: ${manifestResult.error.message}`);
  const sendFn = deps?.send;
  const adapter: WhatsAppAdapter = {
    manifest: manifestResult.value,
    send(envelope: WhatsAppSendEnvelope): WhatsAppSendReceipt | Promise<WhatsAppSendReceipt> {
      if (!sendFn) {
        return { receiptLevel: "commit-unknown", reason: "send-fn-unconfigured" };
      }
      const fail = (err: unknown): WhatsAppSendReceipt => {
        const raw = err instanceof Error ? err.message : String(err);
        return { receiptLevel: "commit-unknown", reason: redact(raw, config.sessionSecret) };
      };
      try {
        const result = sendFn({
          jid: envelope.route.chatId,
          text: envelope.text,
          timeoutMs: config.timeoutMs,
        });
        if (isThenable<WhatsAppSendResult>(result)) {
          return Promise.resolve(result).then(
            (resolved) => receiptFromResult(resolved, envelope.deliveryId),
            fail,
          );
        }
        return receiptFromResult(result, envelope.deliveryId);
      } catch (err) {
        return fail(err);
      }
    },
  };
  return adapter;
}

export function createAdapter(config: unknown, deps?: { send: WhatsAppSendFn }): WhatsAppAdapter {
  if (deps) return createWhatsAppAdapter(config, deps);
  return createWhatsAppAdapter(config);
}
