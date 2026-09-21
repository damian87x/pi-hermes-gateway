import {
  ADAPTER_API_VERSION,
  LIMITS,
  validateAdapterManifest,
  type AdapterManifest,
  type DeliveryRoute,
} from "pi-hermes-gateway-protocol";

export type DedicatedBotConfig = {
  kind: "dedicated-bot";
  token: string;
  timeoutMs: number;
};

export type TelegramHttpRequest = {
  method: "sendMessage";
  url: string;
  body: Record<string, unknown>;
  timeoutMs: number;
};

export type TelegramHttpResult =
  | { kind: "ok"; status: number; json: unknown }
  | { kind: "timeout" };

export type TelegramHttpPost = (request: TelegramHttpRequest) => TelegramHttpResult;

export type TelegramSendEnvelope = {
  deliveryId: string;
  route: DeliveryRoute;
  text: string;
};

export type TelegramSendReceipt = {
  receiptLevel: "accepted" | "commit-unknown";
  providerMessageId?: string;
  reason?: string;
};

export type TelegramAdapter = {
  manifest: AdapterManifest;
  send(envelope: TelegramSendEnvelope): TelegramSendReceipt;
};

const TOKEN_PATTERN = /^[0-9]+:[A-Za-z0-9_-]+$/;
const DEFAULT_TIMEOUT_MS = 10_000;

function redact(text: string, token: string): string {
  return text.split(token).join("<redacted>");
}

export function parseDedicatedBotConfig(input: unknown): DedicatedBotConfig {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("telegram config must be a dedicated-bot object");
  }
  const rec = input as { kind?: unknown; token?: unknown; timeoutMs?: unknown };
  if (rec.kind !== "dedicated-bot") {
    throw new Error("telegram config kind must be dedicated-bot");
  }
  if (typeof rec.token !== "string" || !TOKEN_PATTERN.test(rec.token)) {
    throw new Error("telegram dedicated-bot token is invalid");
  }
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (rec.timeoutMs !== undefined) {
    if (typeof rec.timeoutMs !== "number" || !Number.isInteger(rec.timeoutMs) || rec.timeoutMs < 1) {
      throw new Error("timeoutMs must be a positive integer");
    }
    timeoutMs = rec.timeoutMs;
  }
  return { kind: "dedicated-bot", token: rec.token, timeoutMs };
}

function sendMessageUrl(token: string): string {
  return `https://api.telegram.org/bot${token}/sendMessage`;
}

function messageBody(route: DeliveryRoute, text: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    chat_id: route.chatId,
    text,
  };
  if (route.threadId !== undefined) body.message_thread_id = route.threadId;
  return body;
}

export function createTelegramAdapter(
  configInput: unknown,
  deps?: { post: TelegramHttpPost },
): TelegramAdapter {
  const config = parseDedicatedBotConfig(configInput);
  const manifestResult = validateAdapterManifest({
    adapterId: "telegram",
    adapterApiVersion: ADAPTER_API_VERSION,
    capabilities: ["send.text"],
    configSchemaVersion: 1,
    maxTextLength: LIMITS.maxTextChars,
    receiptLevels: ["accepted"],
  });
  if (!manifestResult.ok) throw new Error(`telegram adapter manifest invalid: ${manifestResult.error.message}`);
  const post = deps?.post;
  const adapter: TelegramAdapter = {
    manifest: manifestResult.value,
    send(envelope: TelegramSendEnvelope): TelegramSendReceipt {
      if (!post) {
        return { receiptLevel: "commit-unknown", reason: "http-client-unconfigured" };
      }
      const url = sendMessageUrl(config.token);
      let result: TelegramHttpResult;
      try {
        result = post({
          method: "sendMessage",
          url,
          body: messageBody(envelope.route, envelope.text),
          timeoutMs: config.timeoutMs,
        });
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        return { receiptLevel: "commit-unknown", reason: redact(raw, config.token) };
      }
      if (result.kind === "timeout") {
        return { receiptLevel: "commit-unknown", reason: "timeout" };
      }
      const json = result.json;
      if (typeof json === "object" && json !== null && (json as { ok?: unknown }).ok === true) {
        const message = (json as { result?: { message_id?: unknown } }).result;
        const id = message?.message_id;
        const providerMessageId = typeof id === "number" || typeof id === "string" ? String(id) : envelope.deliveryId;
        return { receiptLevel: "accepted", providerMessageId };
      }
      return { receiptLevel: "commit-unknown", reason: "telegram-send-unconfirmed" };
    },
  };
  return adapter;
}

export function createAdapter(config: unknown, deps?: { post: TelegramHttpPost }): TelegramAdapter {
  if (deps) return createTelegramAdapter(config, deps);
  return createTelegramAdapter(config);
}
