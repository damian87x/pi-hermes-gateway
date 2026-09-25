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
  const admit = deps.budget.admit();
  if (!admit.ok) {
    return { status: "rejected", reason: "budget_exhausted", message: admit.error.message };
  }
  // job.executablePath is untrusted input and is never used as cliPath; only the loaded profile's path runs.
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
  const outcome = deps.results.insert(job.occurrenceId, result, deps.nowMs());
  return outcome.status === "accepted" ? outcome : { status: "rejected", reason: "duplicate" };
}
