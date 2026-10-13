#!/usr/bin/env node
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadSendAdapter } from "./adapter-loader.js";
import type { SendAdapter } from "./adapter.js";
import { approvePending } from "./core.js";
import { startDaemon } from "./daemon.js";
import { runDoctor } from "./doctor.js";
import { newId } from "./ids.js";
import { ensureProfileDir, profilePaths } from "./profile.js";
import { Store } from "./store.js";
import { createResultsStore } from "./worker/results.js";
import { runWorkerJob } from "./worker/run.js";
import type { DeliveryRoute } from "pi-hermes-gateway-protocol";

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

// The command is the first positional argument; later positionals are its operands.
function commandIndex(): number {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const cur = args[i];
    if (cur === "--profile" || cur === "--restore" || cur === "--node") {
      i += 1;
      continue;
    }
    if (!cur?.startsWith("--")) return i + 2;
  }
  return -1;
}

// Finite commands return their exit status instead of calling process.exit, so Node drains
// piped stdout/stderr before exiting. The daemon path returns undefined and keeps running.
async function cli(): Promise<number | undefined> {
  const profileArg = arg("--profile");
  if (!profileArg) {
    process.stderr.write(
      "usage: pi-hermes-gateway-core --profile DIR [--restore BACKUP] [--resume-dispatch]\n       pi-hermes-gateway-core --profile DIR approve <id>\n       pi-hermes-gateway-core --profile DIR [--node PATH] doctor\n",
    );
    return 2;
  }
  const profileDir: string = profileArg;

  const commandAt = commandIndex();
  const command = commandAt === -1 ? undefined : process.argv[commandAt];

  if (command === "approve") {
    const id = process.argv[commandAt + 1];
    if (!id || id.startsWith("--")) {
      process.stderr.write("usage: pi-hermes-gateway-core --profile DIR approve <id>\n");
      return 2;
    }
    const { dbPath } = profilePaths(profileDir);
    if (!existsSync(dbPath)) {
      process.stderr.write("missing gateway.sqlite\n");
      return 2;
    }
    const store = new Store(dbPath);
    try {
      store.migrate();
      const result = approvePending(store, id, Date.now());
      if (!result.ok) {
        process.stderr.write(`${result.error.message}\n`);
        return 1;
      }
      process.stderr.write(`approved ${result.value.kind} ${result.value.id} -> ${result.value.status}\n`);
    } finally {
      store.close();
    }
    return 0;
  }

  if (command === "worker") {
    const profileId = process.argv[commandAt + 1];
    const occurrenceId = process.argv[commandAt + 2];
    if (!profileId || !occurrenceId || profileId.startsWith("--") || occurrenceId.startsWith("--") || process.argv[commandAt + 3] !== undefined) {
      process.stderr.write("usage: pi-hermes-gateway-core --profile DIR worker <profile-id> <occurrence-id>\n");
      return 2;
    }
    let exitCode = 1;
    // Same ownership/mode guard as the daemon, before the admission ledger is opened.
    try {
      ensureProfileDir(profileDir);
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      return exitCode;
    }
    const workerConfig = {
      provider: process.env.PI_HERMES_WORKER_PROVIDER,
      model: process.env.PI_HERMES_WORKER_MODEL,
      prompt: process.env.PI_HERMES_WORKER_PROMPT,
    };
    const missing = Object.entries(workerConfig).filter(([, value]) => !value?.trim()).map(([key]) => key);
    if (missing.length > 0) {
      process.stderr.write(`missing worker configuration: ${missing.map((key) => `PI_HERMES_WORKER_${key.toUpperCase()}`).join(", ")}\n`);
      return 2;
    }
    const store = new Store(profilePaths(profileDir).dbPath);
    let workerCwd: string | undefined;
    try {
      workerCwd = mkdtempSync(join(tmpdir(), "pi-hermes-worker-"));
      store.migrate();
      if (store.db.prepare("SELECT 1 FROM deliveries WHERE occurrence_id = ? AND source <> 'worker' LIMIT 1").get(occurrenceId)) {
        throw new Error(`worker occurrence already has a delivery: ${occurrenceId}`);
      }
      const results = createResultsStore(store);
      const complete = results.complete;
      results.complete = (id, value, nowMs) => store.transaction(() => {
        if (store.db.prepare("SELECT 1 FROM deliveries WHERE occurrence_id = ? LIMIT 1").get(id)) {
          throw new Error(`worker occurrence already has a delivery: ${id}`);
        }
        const row = complete(id, value, nowMs);
        const text = String((value as { text?: unknown }).text ?? "");
        store.insertDelivery({
          delivery_id: newId("dlv"), job_id: null, occurrence_id: id, source: "worker",
          route_json: "{}", text, not_after_ms: 0, status: "worker-completed", request_id: null,
          created_at_ms: row.acceptedAtMs, dispatch_intent: 0,
        });
        return row;
      });
      // Admission commits before spawn; only result completion and inert delivery publication are atomic.
      const outcome = await runWorkerJob({ profileId, occurrenceId, prompt: workerConfig.prompt! }, {
        dailyInvocationLimit: 1, results, nowMs: Date.now,
        provider: workerConfig.provider!, model: workerConfig.model!, cwd: workerCwd, timeoutMs: 60_000, maxOutputBytes: 1_048_576,
        spawnGuard: (spawn) => store.transaction(() => {
          if (store.db.prepare("SELECT 1 FROM deliveries WHERE occurrence_id = ? LIMIT 1").get(occurrenceId)) {
            throw new Error(`worker occurrence already has a delivery: ${occurrenceId}`);
          }
          return spawn();
        }),
      });
      if (outcome.status === "accepted") exitCode = 0;
      process.stdout.write(`${JSON.stringify(outcome)}\n`);
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    } finally {
      try {
        if (workerCwd) rmSync(workerCwd, { recursive: true, force: true });
      } finally {
        store.close();
      }
    }
    return exitCode;
  }

  if (command === "doctor") {
    const nodePath = arg("--node") ?? process.execPath;
    const cliPath = fileURLToPath(import.meta.url);
    const report = runDoctor({ profileDir, nodePath, cliPath });
    process.stdout.write(`${JSON.stringify(report)}\n`);
    for (const check of report.checks) {
      if (check.severity === "warn") process.stderr.write(`${check.message}\n`);
    }
    return report.ok ? 0 : 1;
  }

  const restoreFromBackup = arg("--restore");
  const resumeDispatch = process.argv.includes("--resume-dispatch");
  if (restoreFromBackup && resumeDispatch) {
    process.stderr.write("restore and resume-dispatch cannot be combined\n");
    return 2;
  }

  const configPath = join(profileDir, "config.json");
  if (!existsSync(configPath)) {
    process.stderr.write("missing profile config.json\n");
    return 2;
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
  return undefined;
}

// Errors that escape a command (e.g. the ledger cannot be opened) end it with a diagnostic, not a stack.
const exitCode = await cli().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  return 1;
});
if (exitCode !== undefined) process.exitCode = exitCode;
