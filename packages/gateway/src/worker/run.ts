import { DailyInvocationBudget } from "./budgets.js";
import { loadWorkerProfile, type WorkerJobBody, type WorkerProfile } from "./profiles.js";
import { runWorker } from "./runner.js";
import type { ResultRow, ResultsStore } from "./results.js";

export type RunWorkerJobInput = WorkerJobBody & {
  readonly occurrenceId: string;
  readonly prompt: string;
  readonly executablePath?: string;
};

export type RunWorkerJobDeps = {
  budget: DailyInvocationBudget;
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
  if (!deps.results.claim(job.occurrenceId, deps.nowMs())) {
    return { status: "rejected", reason: "duplicate" };
  }
  const admit = deps.budget.admit();
  if (!admit.ok) {
    deps.results.releaseUnstarted(job.occurrenceId);
    return { status: "rejected", reason: "budget_exhausted", message: admit.error.message };
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
