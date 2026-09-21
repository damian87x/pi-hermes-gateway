#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { loadSendAdapter } from "./adapter-loader.js";
import type { SendAdapter } from "./adapter.js";
import { startDaemon } from "./daemon.js";
import type { DeliveryRoute } from "pi-hermes-gateway-protocol";

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

const profileArg = arg("--profile");
if (!profileArg) {
  process.stderr.write("usage: pi-hermes-gateway-core --profile DIR [--restore BACKUP] [--resume-dispatch]\n");
  process.exit(2);
}
const profileDir: string = profileArg;

const restoreFromBackup = arg("--restore");
const resumeDispatch = process.argv.includes("--resume-dispatch");
if (restoreFromBackup && resumeDispatch) {
  process.stderr.write("restore and resume-dispatch cannot be combined\n");
  process.exit(2);
}

const configPath = join(profileDir, "config.json");
if (!existsSync(configPath)) {
  process.stderr.write("missing profile config.json\n");
  process.exit(2);
}

const config = JSON.parse(readFileSync(configPath, "utf8")) as {
  routes: DeliveryRoute[];
  catchUpPolicy?: "skip" | "one-latest";
  adapter?: { module: string; config?: unknown };
};

async function main(): Promise<void> {
  let adapter: SendAdapter | undefined;
  if (config.adapter?.module) {
    adapter = await loadSendAdapter(config.adapter.module, config.adapter.config ?? null, profileDir);
  }
  const daemon = startDaemon({
    profileDir,
    routes: config.routes,
    ...(adapter ? { adapter } : {}),
    ...(config.catchUpPolicy ? { catchUpPolicy: config.catchUpPolicy } : {}),
    ...(restoreFromBackup ? { restoreFromBackup } : {}),
    ...(resumeDispatch ? { resumeDispatch: true } : {}),
  });
  process.stderr.write("gateway listening\n");
  process.on("SIGTERM", () => {
    daemon.stop();
    process.exit(0);
  });
  process.on("SIGINT", () => {
    daemon.stop();
    process.exit(0);
  });
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
