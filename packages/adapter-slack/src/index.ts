import {
  ADAPTER_API_VERSION,
  LIMITS,
  validateAdapterManifest,
  type AdapterManifest,
  type DeliveryRoute,
} from "pi-hermes-gateway-protocol";

export type BotTokenConfig = {
  kind: "bot-token";
  token: string;
  timeoutMs: number;
  apiOrigin?: string;
};

export type SlackHttpRequest = {
  method: "chat.postMessage";
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  timeoutMs: number;
};

export type SlackHttpResult =
  | { kind: "ok"; status: number; json: unknown }
  | { kind: "timeout" };

export type SlackHttpPost = (
  request: SlackHttpRequest,
) => SlackHttpResult | Promise<SlackHttpResult>;

export type SlackSendEnvelope = {
  deliveryId: string;
  route: DeliveryRoute;
  text: string;
};

export type SlackSendReceipt = {
  receiptLevel: "accepted" | "commit-unknown";
  providerMessageId?: string;
  reason?: string;
};

export type SlackAdapter = {
  manifest: AdapterManifest;
  send(envelope: SlackSendEnvelope): SlackSendReceipt | Promise<SlackSendReceipt>;
};

const TOKEN_PATTERN = /^xoxb-[A-Za-z0-9-]+$/;
const ORIGIN_PATTERN = /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?$/;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_API_ORIGIN = "https://slack.com";
const ALLOWED_CONFIG_KEYS = new Set(["kind", "token", "timeoutMs", "apiOrigin"]);

function redact(text: string, token: string): string {
  return text.split(token).join("<redacted>");
}

function isThenable<T>(value: unknown): value is Promise<T> {
  return typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function";
}

export function parseBotTokenConfig(input: unknown): BotTokenConfig {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("slack config must be a bot-token object");
  }
  const rec = input as { kind?: unknown; token?: unknown; timeoutMs?: unknown; apiOrigin?: unknown };
  if (rec.kind !== "bot-token") {
    throw new Error("slack config kind must be bot-token");
  }
  for (const key of Object.keys(rec)) {
    if (!ALLOWED_CONFIG_KEYS.has(key)) {
      throw new Error("slack config is invalid");
    }
  }
  if (typeof rec.token !== "string" || !TOKEN_PATTERN.test(rec.token)) {
    throw new Error("slack bot-token token is invalid");
  }
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (rec.timeoutMs !== undefined) {
    if (typeof rec.timeoutMs !== "number" || !Number.isInteger(rec.timeoutMs) || rec.timeoutMs < 1) {
      throw new Error("timeoutMs must be a positive integer");
    }
    timeoutMs = rec.timeoutMs;
  }
  const parsed: BotTokenConfig = { kind: "bot-token", token: rec.token, timeoutMs };
  if (rec.apiOrigin !== undefined) {
    if (typeof rec.apiOrigin !== "string" || !ORIGIN_PATTERN.test(rec.apiOrigin)) {
      throw new Error("apiOrigin must be an http(s) host origin");
    }
    parsed.apiOrigin = rec.apiOrigin;
  }
  return parsed;
}

function postMessageUrl(apiOrigin = DEFAULT_API_ORIGIN): string {
  return `${apiOrigin}/api/chat.postMessage`;
}

function messageBody(route: DeliveryRoute, text: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    channel: route.chatId,
    text,
  };
  if (route.threadId !== undefined) body.thread_ts = route.threadId;
  return body;
}

function authHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
}

function bearerToken(headers: Record<string, string> | undefined): string | undefined {
  const auth = headers?.authorization;
  if (typeof auth !== "string" || !auth.startsWith("Bearer ")) return undefined;
  return auth.slice("Bearer ".length);
}

function isAbortOrTimeout(err: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  const name = err instanceof Error ? err.name : "";
  return name === "AbortError" || name === "TimeoutError";
}

export async function defaultSlackHttpPost(request: SlackHttpRequest): Promise<SlackHttpResult> {
  const signal = AbortSignal.timeout(request.timeoutMs);
  try {
    const response = await fetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal,
    });
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      json = undefined;
    }
    return { kind: "ok", status: response.status, json };
  } catch (err) {
    if (isAbortOrTimeout(err, signal)) return { kind: "timeout" };
    const raw = err instanceof Error ? err.message : String(err);
    const token = bearerToken(request.headers);
    throw new Error(token ? redact(raw, token) : raw);
  }
}

function receiptFromResult(result: SlackHttpResult, deliveryId: string): SlackSendReceipt {
  if (result.kind === "timeout") {
    return { receiptLevel: "commit-unknown", reason: "timeout" };
  }
  const json = result.json;
  if (typeof json === "object" && json !== null && (json as { ok?: unknown }).ok === true) {
    const ts = (json as { ts?: unknown }).ts;
    const providerMessageId = typeof ts === "number" || typeof ts === "string" ? String(ts) : deliveryId;
    return { receiptLevel: "accepted", providerMessageId };
  }
  return { receiptLevel: "commit-unknown", reason: "slack-send-unconfirmed" };
}

export function createSlackAdapter(
  configInput: unknown,
  deps?: { post: SlackHttpPost },
): SlackAdapter {
  const config = parseBotTokenConfig(configInput);
  const manifestResult = validateAdapterManifest({
    adapterId: "slack",
    adapterApiVersion: ADAPTER_API_VERSION,
    capabilities: ["send.text"],
    configSchemaVersion: 1,
    maxTextLength: LIMITS.maxTextChars,
    receiptLevels: ["accepted"],
  });
  if (!manifestResult.ok) throw new Error(`slack adapter manifest invalid: ${manifestResult.error.message}`);
  const post = deps?.post;
  const adapter: SlackAdapter = {
    manifest: manifestResult.value,
    send(envelope: SlackSendEnvelope): SlackSendReceipt | Promise<SlackSendReceipt> {
      if (!post) {
        return { receiptLevel: "commit-unknown", reason: "http-client-unconfigured" };
      }
      const fail = (err: unknown): SlackSendReceipt => {
        const raw = err instanceof Error ? err.message : String(err);
        return { receiptLevel: "commit-unknown", reason: redact(raw, config.token) };
      };
      try {
        const result = post({
          method: "chat.postMessage",
          url: postMessageUrl(config.apiOrigin),
          headers: authHeaders(config.token),
          body: messageBody(envelope.route, envelope.text),
          timeoutMs: config.timeoutMs,
        });
        if (isThenable<SlackHttpResult>(result)) {
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

export function createAdapter(config: unknown, deps?: { post: SlackHttpPost }): SlackAdapter {
  if (deps) return createSlackAdapter(config, deps);
  return createSlackAdapter(config);
}
