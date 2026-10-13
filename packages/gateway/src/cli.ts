#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadSendAdapter } from "./adapter-loader.js";
import type { SendAdapter } from "./adapter.js";
import { approvePending, type GatewayResponse } from "./core.js";
import { startDaemon } from "./daemon.js";
import { runDoctor } from "./doctor.js";
import { newId } from "./ids.js";
import { sendIpc } from "./ipc.js";
import { ensureProfileDir, profilePaths } from "./profile.js";
import { Store } from "./store.js";
import { createResultsStore } from "./worker/results.js";
import { runWorkerJob } from "./worker/run.js";
import { PROTOCOL_VERSION, type DeliveryRoute, type JobSchedule, type StaticTextJobCreate } from "pi-hermes-gateway-protocol";

const USAGE =
  "usage: pi-hermes-gateway-core --profile DIR [--restore BACKUP] [--resume-dispatch]\n" +
  "       pi-hermes-gateway-core --profile DIR approve <id>\n" +
  "       pi-hermes-gateway-core --profile DIR [--node PATH] doctor\n" +
  "       pi-hermes-gateway-core --profile DIR job create --text T (--at ISO-UTC | --daily HH:MM --tz IANA) [--route N] [--request-id ID]\n" +
  "       pi-hermes-gateway-core --profile DIR job list\n";

const JOB_USAGE =
  "usage: pi-hermes-gateway-core --profile DIR job create --text T (--at ISO-UTC | --daily HH:MM --tz IANA) [--route N] [--request-id ID]\n" +
  "       pi-hermes-gateway-core --profile DIR job list\n";

// The CLI sends requests over the profile socket with a short TTL; the daemon enforces the protocol bound.
const REQUEST_TTL_MS = 30_000;

type ProfileConfig = {
  routes: DeliveryRoute[];
  catchUpPolicy?: "skip" | "one-latest";
  adapter?: { module: string; config?: unknown };
};

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function readProfileConfig(profileDir: string): ProfileConfig | undefined {
  const configPath = join(profileDir, "config.json");
  if (!existsSync(configPath)) {
    process.stderr.write("missing profile config.json\n");
    return undefined;
  }
  return JSON.parse(readFileSync(configPath, "utf8")) as ProfileConfig;
}

// Operands after `job <sub>` are `--flag value` pairs from `allowed`; `--profile DIR` is skipped because
// arg() already consumed it. Any other flag, a repeated flag, or a stray positional is a usage error.
function parseJobOptions(args: string[], allowed: readonly string[]): Map<string, string> | string {
  const opts = new Map<string, string>();
  for (let i = 0; i < args.length; i += 1) {
    const cur = args[i]!;
    if (cur === "--profile") {
      i += 1;
      continue;
    }
    if (!cur.startsWith("--")) return `unexpected argument ${cur}`;
    if (!allowed.includes(cur)) return `unknown option ${cur}`;
    if (opts.has(cur)) return `duplicate option ${cur}`;
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--")) return `${cur} requires a value`;
    opts.set(cur, value);
    i += 1;
  }
  return opts;
}

// Builds the job.create body from parsed options; schedule and text formats are validated by the daemon,
// the route index is resolved here because only the configured route list can be sent on the wire.
function jobCreateBody(opts: Map<string, string>, routes: DeliveryRoute[]): StaticTextJobCreate | string {
  const text = opts.get("--text");
  if (text === undefined) return "--text is required";
  if (text.length === 0) return "--text must be non-empty";
  const at = opts.get("--at");
  const daily = opts.get("--daily");
  const tz = opts.get("--tz");
  let schedule: JobSchedule;
  if (at !== undefined) {
    if (daily !== undefined || tz !== undefined) return "--at cannot be combined with --daily or --tz";
    schedule = { type: "once", atUtc: at };
  } else if (daily !== undefined && tz !== undefined) {
    schedule = { type: "daily", localTime: daily, timeZone: tz };
  } else if (daily !== undefined) {
    return "--daily requires --tz";
  } else if (tz !== undefined) {
    return "--tz requires --daily";
  } else {
    return "one of --at or --daily with --tz is required";
  }
  const routeArg = opts.get("--route");
  let index = 0;
  if (routeArg === undefined) {
    if (routes.length !== 1) return `--route is required when ${routes.length} routes are configured`;
  } else {
    if (!/^\d+$/.test(routeArg)) return "--route must be a non-negative integer index into the configured routes";
    index = Number(routeArg);
  }
  const route = routes[index];
  if (!route) return `invalid_route: route index ${index} is not configured (${routes.length} configured)`;
  return { kind: "static-text", text, route, schedule, requireApproval: false };
}

function isGatewayResponse(value: unknown): value is GatewayResponse {
  if (typeof value !== "object" || value === null || typeof (value as { ok?: unknown }).ok !== "boolean") return false;
  if ((value as { ok: boolean }).ok) return true;
  const error = (value as { error?: { code?: unknown; message?: unknown } }).error;
  return typeof error?.code === "string" && typeof error.message === "string";
}

// Job commands only talk to the running daemon over the profile socket: they never open the ledger, so a
// missing daemon leaves the profile untouched.
async function jobCommand(profileDir: string, commandAt: number): Promise<number> {
  const sub = process.argv[commandAt + 1];
  if (sub !== "create" && sub !== "list") {
    process.stderr.write(JOB_USAGE);
    return 2;
  }
  const config = readProfileConfig(profileDir);
  if (!config) return 2;
  const operands = process.argv.slice(commandAt + 2);
  const opts = parseJobOptions(operands, sub === "create" ? ["--text", "--at", "--daily", "--tz", "--route", "--request-id"] : []);
  if (typeof opts === "string") {
    process.stderr.write(`${opts}\n${JOB_USAGE}`);
    return 2;
  }
  let body: unknown = {};
  if (sub === "create") {
    const created = jobCreateBody(opts, config.routes);
    if (typeof created === "string") {
      process.stderr.write(created.startsWith("invalid_route:") ? `${created}\n` : `${created}\n${JOB_USAGE}`);
      return created.startsWith("invalid_route:") ? 1 : 2;
    }
    body = created;
  }
  const { socketPath } = profilePaths(profileDir);
  const request = {
    protocolVersion: PROTOCOL_VERSION,
    // Generated ids use "-" because the protocol request-id pattern has no "_" (unlike newId's job ids).
    requestId: opts.get("--request-id") ?? `req-${randomBytes(12).toString("hex")}`,
    method: sub === "create" ? "job.create" : "job.list",
    body,
    expiresAt: Date.now() + REQUEST_TTL_MS,
  };
  let response: unknown;
  try {
    response = await sendIpc(socketPath, request);
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    process.stderr.write(`gateway daemon is not running: cannot connect to ${socketPath}${typeof code === "string" ? ` (${code})` : ""}\n`);
    return 1;
  }
  if (!isGatewayResponse(response)) {
    process.stderr.write("unexpected gateway response\n");
    return 1;
  }
  if (!response.ok) {
    process.stderr.write(`${response.error.code}: ${response.error.message}\n`);
    return 1;
  }
  if (sub === "list") {
    process.stdout.write(`${JSON.stringify(response.body)}\n`);
    return 0;
  }
  const jobId = (response.body as { jobId?: unknown } | null)?.jobId;
  if (typeof jobId !== "string") {
    process.stderr.write("unexpected gateway response\n");
    return 1;
  }
  process.stdout.write(`${jobId}\n`);
  return 0;
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
    process.stderr.write(USAGE);
    return 2;
  }
  const profileDir: string = profileArg;

  const commandAt = commandIndex();
  const command = commandAt === -1 ? undefined : process.argv[commandAt];

  if (command === "job") return jobCommand(profileDir, commandAt);

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

  const loadedConfig = readProfileConfig(profileDir);
  if (!loadedConfig) return 2;
  // Hoisted function declarations do not keep the narrowing above, so bind the non-optional config here.
  const config: ProfileConfig = loadedConfig;

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
