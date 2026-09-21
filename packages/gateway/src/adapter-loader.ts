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
  const adapter = typeof factory === "function" ? (factory as (c: unknown) => unknown)(config) : mod;
  if (!isSendAdapter(adapter)) {
    throw new Error("adapter module did not export a structural send adapter");
  }
  return adapter;
}
