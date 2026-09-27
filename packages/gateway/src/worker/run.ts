import { loadWorkerProfile, type WorkerJobBody, type WorkerProfile } from "./profiles.js";
import { runWorker } from "./runner.js";
import type { ResultRow, ResultsStore } from "./results.js";

export type RunWorkerJobInput = WorkerJobBody & {
  readonly occurrenceId: string;
  readonly prompt: string;
  readonly executablePath?: string;
};

export type RunWorkerJobDeps = {
  dailyInvocationLimit: number;
  results: ResultsStore;
  nowMs: () => number;
  provider: string;
  model: string;
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  env?: Record<string, string>;
  loadProfile?: (job: WorkerJobBody) => WorkerProfile;
};

export type RunWorkerJobOutcome =
  | { status: "accepted"; row: ResultRow }
  | { status: "rejected"; reason: "duplicate" }
  | { status: "rejected"; reason: "budget_exhausted"; message: string };

export async function runWorkerJob(job: RunWorkerJobInput, deps: RunWorkerJobDeps): Promise<RunWorkerJobOutcome> {
  const profile = (deps.loadProfile ?? loadWorkerProfile)(job);
  const claim = deps.results.claim(job.occurrenceId, deps.nowMs, deps.dailyInvocationLimit);
  if (claim === "duplicate") return { status: "rejected", reason: "duplicate" };
  if (claim === "budget_exhausted") {
    return { status: "rejected", reason: "budget_exhausted", message: "daily invocation budget exhausted" };
  }
  try {
    // job.executablePath is untrusted input; only the loaded profile's path runs.
    const result = await runWorker({
      cliPath: profile.executablePath,
      cliPrefixArgs: profile.args,
      provider: deps.provider,
      model: deps.model,
      prompt: job.prompt,
      cwd: deps.cwd,
      timeoutMs: deps.timeoutMs,
      maxOutputBytes: deps.maxOutputBytes,
      ...(deps.env ? { env: deps.env } : {}),
    });
    // Only a completed run may accept; timeouts and rejections fall through to the interrupt path below.
    if (result.kind !== "ok") throw new Error(`worker did not complete: ${JSON.stringify(result)}`);
    return { status: "accepted", row: deps.results.complete(job.occurrenceId, result, deps.nowMs()) };
  } catch (error) {
    // Spawn/result failures are uncertain: retain the claim, never silently retry.
    try {
      deps.results.interrupt(job.occurrenceId);
    } catch (persistError) {
      throw new AggregateError([error, persistError], "worker failed and claim status could not be persisted");
    }
    throw error;
  }
}
