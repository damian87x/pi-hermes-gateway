import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DailyInvocationBudget } from "../dist/worker/budgets.js";
import { createResultsStore } from "../dist/worker/results.js";
import { runWorkerJob } from "../dist/worker/run.js";

const FAKE_WORKER = `
const { writeFileSync } = require("node:fs");
if (process.env.MARKER) writeFileSync(process.env.MARKER, String(process.pid));
process.stdout.write("worker ok\\n");
`;

function setup(limit = 1) {
  const dir = mkdtempSync(join(tmpdir(), "w1e-"));
  const script = join(dir, "fake-worker.cjs");
  writeFileSync(script, FAKE_WORKER);
  const marker = join(dir, "marker");
  const fakeProfile = { id: "fake", executablePath: process.execPath, args: [script] };
  const deps = {
    budget: new DailyInvocationBudget(limit),
    results: createResultsStore(),
    nowMs: () => 1000,
    provider: "fake",
    model: "fake-model",
    cwd: dir,
    timeoutMs: 5_000,
    maxOutputBytes: 1024,
    env: { MARKER: marker },
    loadProfile: () => fakeProfile,
  };
  const job = { profileId: "fake", occurrenceId: "occ-1", prompt: "go", executablePath: "/bin/should-not-run" };
  const done = () => rmSync(dir, { recursive: true, force: true });
  return { marker, deps, job, done };
}

test("worker-run: loads the profile, runs its absolute CLI, and stores one accepted result", async () => {
  const { marker, deps, job, done } = setup();
  try {
    const outcome = await runWorkerJob(job, deps);
    assert.equal(outcome.status, "accepted");
    assert.equal(deps.results.list().length, 1);
    assert.equal(Number(readFileSync(marker, "utf8")) > 0, true, "profile executable should have run");
  } finally {
    done();
  }
});

test("worker-run: ignores any executablePath on the job body", async () => {
  const { deps, job, done } = setup();
  try {
    const outcome = await runWorkerJob({ ...job, executablePath: "/definitely/not/a/real/binary" }, deps);
    assert.equal(outcome.status, "accepted");
  } finally {
    done();
  }
});

test("worker-run: exhausted budget is rejected without spawning", async () => {
  const { marker, deps, job, done } = setup(0);
  try {
    const outcome = await runWorkerJob(job, deps);
    assert.deepEqual(outcome, { status: "rejected", reason: "budget_exhausted", message: "daily invocation budget exhausted" });
    assert.equal(existsSync(marker), false, "worker executable should not have run");
    assert.equal(deps.results.list().length, 0);
  } finally {
    done();
  }
});

test("worker-run: a second insert for the same occurrence is rejected", async () => {
  const { deps, job, done } = setup(2);
  try {
    const first = await runWorkerJob(job, deps);
    assert.equal(first.status, "accepted");
    const second = await runWorkerJob(job, deps);
    assert.deepEqual(second, { status: "rejected", reason: "duplicate" });
    assert.equal(deps.results.list().length, 1);
  } finally {
    done();
  }
});
