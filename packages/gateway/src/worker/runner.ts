import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import process from "node:process";

export const ISOLATION_FLAGS = [
  "--no-extensions",
  "--no-skills",
  "--no-context-files",
  "--no-prompt-templates",
  "--no-tools",
] as const;

const STDERR_CAP = 16 * 1024;

export interface RunWorkerOptions {
  cliPath: string;
  cliPrefixArgs?: readonly string[];
  provider: string;
  model: string;
  prompt: string;
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  env?: Record<string, string>;
}

export type WorkerResult =
  | { kind: "ok"; text: string }
  | { kind: "timeout" }
  | { kind: "rejected"; reason: "oversized" | "malformed" }
  | { kind: "rejected"; reason: "exit"; code: number | null; signal?: string };

export function workerArgv(opts: Pick<RunWorkerOptions, "cliPrefixArgs" | "provider" | "model" | "prompt">): string[] {
  return [
    ...(opts.cliPrefixArgs ?? []),
    "--print",
    "--no-session",
    "--provider",
    opts.provider,
    "--model",
    opts.model,
    ...ISOLATION_FLAGS,
    "--",
    opts.prompt,
  ];
}

type Chunk = Uint8Array | string;
type ClosableChild = { on(ev: "close", fn: (code: number | null, signal: string | null) => void): void };

export async function runWorker(opts: RunWorkerOptions): Promise<WorkerResult> {
  if (!isAbsolute(opts.cliPath)) throw new Error(`worker CLI path must be absolute: ${opts.cliPath}`);
  // detached: the child leads its own process group so kill(-pid) reaches grandchildren.
  const spawnOpts = { cwd: opts.cwd, env: opts.env ?? {}, detached: true, stdio: ["ignore", "pipe", "pipe"] };
  const child = spawn(opts.cliPath, workerArgv(opts), spawnOpts);
  const pid = child.pid;
  const killGroup = () => {
    if (pid === undefined) return;
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // group already gone
    }
  };

  return await new Promise<WorkerResult>((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    let stderrBytes = 0;
    let verdict: WorkerResult | undefined;

    const stop = (r: WorkerResult) => {
      if (verdict) return;
      verdict = r;
      killGroup();
    };
    const timer = setTimeout(() => stop({ kind: "timeout" }), opts.timeoutMs);

    child.stdout?.on("data", (c: Chunk) => {
      if (verdict) return;
      const buf = typeof c === "string" ? new TextEncoder().encode(c) : c;
      bytes += buf.length;
      if (bytes > opts.maxOutputBytes) return stop({ kind: "rejected", reason: "oversized" });
      chunks.push(buf);
    });
    child.stderr?.on("data", (c: Chunk) => {
      stderrBytes += c.length;
      if (stderrBytes > STDERR_CAP) stop({ kind: "rejected", reason: "oversized" });
    });
    child.on("error", (err) => {
      clearTimeout(timer as number);
      killGroup();
      reject(err);
    });
    (child as unknown as ClosableChild).on("close", (code, signal) => {
      clearTimeout(timer as number);
      killGroup();
      if (verdict) return resolve(verdict);
      if (code !== 0) {
        return resolve(
          signal ? { kind: "rejected", reason: "exit", code, signal } : { kind: "rejected", reason: "exit", code },
        );
      }
      resolve(parseOutput(concat(chunks, bytes)));
    });
  });
}

declare function clearTimeout(id: number): void;

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

function parseOutput(buf: Uint8Array): WorkerResult {
  const decoded = new TextDecoder().decode(buf);
  // Invalid UTF-8 decodes to U+FFFD, so a lossless round-trip proves the bytes were well-formed.
  const roundTrip = new TextEncoder().encode(decoded);
  const lossless = roundTrip.length === buf.length && roundTrip.every((b, i) => b === buf[i]);
  const text = decoded.trim();
  if (!lossless || text.length === 0 || text.includes("\u0000")) return { kind: "rejected", reason: "malformed" };
  return { kind: "ok", text };
}
