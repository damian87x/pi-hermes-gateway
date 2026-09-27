export type WorkerProfile = {
  readonly id: string;
  readonly executablePath: string;
  readonly args: readonly string[];
};

export type WorkerJobBody = {
  readonly profileId: string;
};

const WORKER_PROFILES: Readonly<Record<string, WorkerProfile>> = Object.freeze({
  report: Object.freeze({
    id: "report",
    executablePath: "/usr/local/libexec/pi-hermes-gateway/report-worker",
    args: [],
  }),
});

export function loadWorkerProfile(job: WorkerJobBody): WorkerProfile {
  // Own keys only: inherited names such as "__proto__" are not profiles.
  const profile = Object.hasOwn(WORKER_PROFILES, job.profileId) ? WORKER_PROFILES[job.profileId] : undefined;
  if (!profile) {
    const known = Object.keys(WORKER_PROFILES).join(", ") || "none";
    throw new Error(`unknown worker profile id "${job.profileId}"; known profiles: ${known}`);
  }
  return profile;
}
