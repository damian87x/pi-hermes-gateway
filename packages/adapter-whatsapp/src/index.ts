import { resolve } from "node:path";
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
  | { kind: "unknown" }
  | { kind: "unconfigured" };

export type WhatsAppSendFn = (
  request: WhatsAppSendRequest,
) => WhatsAppSendResult | Promise<WhatsAppSendResult>;

/**
 * Minimal linked-device socket surface the default sender uses. `sendMessage` resolves to the
 * provider's message record (its `key.id` becomes the provider message id). `close` is a routine
 * disconnect; the sender never unlinks the device.
 */
export type WhatsAppSocket = {
  sendMessage(jid: string, content: { text: string }): unknown;
  close?(): unknown;
};

/** Operator-supplied factory; receives the gateway-owned auth directory and nothing else. */
export type WhatsAppSocketFactory = (options: { authDir: string }) => WhatsAppSocket | Promise<WhatsAppSocket>;

export type WhatsAppSocketDeps = {
  socketFactory: WhatsAppSocketFactory;
  profileDir: string;
};

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

/** Fixed child of the gateway profile directory that holds this adapter's own credentials. */
export const WHATSAPP_AUTH_DIR_NAME = "whatsapp-auth";

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

/**
 * The auth directory is always derived from the gateway profile directory and is never a config
 * value, so this adapter cannot be pointed at a user's existing WhatsApp session.
 */
export function whatsAppAuthDir(profileDir: string): string {
  if (typeof profileDir !== "string" || profileDir.trim().length === 0) {
    throw new Error("whatsapp profileDir is required");
  }
  return resolve(profileDir, WHATSAPP_AUTH_DIR_NAME);
}

function providerMessageIdFrom(message: unknown): string | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const key = (message as { key?: unknown }).key;
  if (typeof key !== "object" || key === null) return undefined;
  const id = (key as { id?: unknown }).id;
  if (typeof id !== "string") return undefined;
  const trimmed = id.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

async function closeQuietly(socket: WhatsAppSocket | undefined): Promise<void> {
  if (!socket || typeof socket.close !== "function") return;
  try {
    await socket.close();
  } catch {
    // A failed routine disconnect is not a send outcome.
  }
}

/**
 * Binds a socket factory and profile directory into a `WhatsAppSendFn`. Each send opens one socket
 * at the profile-owned auth dir, sends the text, and closes the socket. Timeout wins the race and
 * reports `timeout`; a socket opened after the timeout is closed without sending.
 */
export function createWhatsAppSend(deps: WhatsAppSocketDeps): WhatsAppSendFn {
  if (typeof deps !== "object" || deps === null || typeof deps.socketFactory !== "function") {
    throw new Error("whatsapp socketFactory is required");
  }
  const socketFactory = deps.socketFactory;
  const authDir = whatsAppAuthDir(deps.profileDir);
  const redactPath = (text: string): string => text.split(authDir).join("<auth-dir>");
  return async (request: WhatsAppSendRequest): Promise<WhatsAppSendResult> => {
    let timedOut = false;
    let timer: unknown;
    let socket: WhatsAppSocket | undefined;
    const timeout = new Promise<WhatsAppSendResult>((settle) => {
      timer = setTimeout(() => {
        timedOut = true;
        settle({ kind: "timeout" });
      }, request.timeoutMs);
    });
    const attempt = (async (): Promise<WhatsAppSendResult> => {
      const opened = await socketFactory({ authDir });
      if (timedOut) {
        void closeQuietly(opened);
        return { kind: "timeout" };
      }
      socket = opened;
      const message = await opened.sendMessage(request.jid, { text: request.text });
      const providerMessageId = providerMessageIdFrom(message);
      return providerMessageId === undefined ? { kind: "ok" } : { kind: "ok", providerMessageId };
    })();
    // A late rejection after the timeout already won must not become an unhandled rejection.
    attempt.catch(() => undefined);
    try {
      return await Promise.race([attempt, timeout]);
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      throw new Error(redactPath(raw));
    } finally {
      clearTimeout(timer);
      void closeQuietly(socket);
    }
  };
}

/**
 * Default sender injected by the gateway loader. Without socket deps it is unconfigured: it returns
 * `unconfigured` synchronously, opens nothing, and sends nothing. With deps it behaves like
 * `createWhatsAppSend(deps)(request)`.
 */
export function defaultWhatsAppSend(
  request: WhatsAppSendRequest,
  deps?: WhatsAppSocketDeps,
): WhatsAppSendResult | Promise<WhatsAppSendResult> {
  if (deps === undefined) return { kind: "unconfigured" };
  return createWhatsAppSend(deps)(request);
}

function receiptFromResult(result: WhatsAppSendResult): WhatsAppSendReceipt {
  if (result.kind === "timeout") {
    return { receiptLevel: "commit-unknown", reason: "timeout" };
  }
  if (result.kind === "unconfigured") {
    return { receiptLevel: "commit-unknown", reason: "whatsapp-socket-unconfigured" };
  }
  if (result.kind === "ok") {
    const id = result.providerMessageId;
    if (typeof id === "string" && id.trim().length > 0) {
      return { receiptLevel: "accepted", providerMessageId: id };
    }
    return { receiptLevel: "commit-unknown", reason: "whatsapp-send-unconfirmed" };
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
            (resolved) => receiptFromResult(resolved),
            fail,
          );
        }
        return receiptFromResult(result);
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
