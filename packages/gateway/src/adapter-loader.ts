import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isSendAdapter, type SendAdapter } from "./adapter.js";

export async function loadSendAdapter(
  modulePath: string,
  config: unknown = null,
  fromDir = ".",
): Promise<SendAdapter> {
  const resolved = isAbsolute(modulePath) ? modulePath : resolve(fromDir, modulePath);
  const mod = (await import(pathToFileURL(resolved).href)) as Record<string, unknown>;
  const factory = mod.createAdapter ?? mod.default;
  const post = mod.defaultTelegramHttpPost;
  const send = mod.defaultWhatsAppSend;
  let adapter: unknown;
  if (typeof factory === "function") {
    if (typeof post === "function") {
      adapter = (factory as (c: unknown, d: { post: unknown }) => unknown)(config, { post });
    } else if (typeof send === "function") {
      adapter = (factory as (c: unknown, d: { send: unknown }) => unknown)(config, { send });
    } else {
      adapter = (factory as (c: unknown) => unknown)(config);
    }
  } else {
    adapter = mod;
  }
  if (!isSendAdapter(adapter)) {
    throw new Error("adapter module did not export a structural send adapter");
  }
  return adapter;
}
