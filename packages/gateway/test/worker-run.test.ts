import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Store } from "../dist/store.js";
import { profilePaths } from "../dist/profile.js";
import { createResultsStore } from "../dist/worker/results.js";
import { runWorkerJob } from "../dist/worker/run.js";

const FAKE_WORKER = `
const { appendFileSync } = require("node:fs");
if (process.env.MARKER) appendFileSync(process.env.MARKER, String(process.pid) + "\\n");
process.stdout.write("worker ok\\n");
`;

function setup(limit = 1) {
  const dir = mkdtempSync(join(tmpdir(), "w1e-"));
  const script = join(dir, "fake-worker.cjs");
  writeFileSync(script, FAKE_WORKER);
  const marker = join(dir, "marker");
  const fakeProfile = { id: "fake", executablePath: process.execPath, args: [script] };
  const dbPath = profilePaths(dir).dbPath;
  let store = new Store(dbPath);
  store.migrate();
  const deps = {
    dailyInvocationLimit: limit,
    results: createResultsStore(store),
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
  const reopen = () => {
    store.close();
    store = new Store(dbPath);
    store.migrate();
    deps.results = createResultsStore(store);
  };
  const done = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { marker, deps, job, done, reopen, dbPath };
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
  const { marker, deps, job, done } = setup(1);
  try {
    const first = await runWorkerJob(job, deps);
    assert.equal(first.status, "accepted");
    const pidAfterFirst = readFileSync(marker, "utf8");
    const second = await runWorkerJob(job, deps);
    assert.deepEqual(second, { status: "rejected", reason: "duplicate" });
    assert.equal(deps.results.list().length, 1);
    assert.equal(readFileSync(marker, "utf8"), pidAfterFirst, "worker should not have spawned again");
  } finally {
    done();
  }
});

test("worker-run: concurrent occurrence calls spawn once without spending duplicate budget", async () => {
  const { marker, deps, job, done } = setup(2);
  try {
    const outcomes = await Promise.all([runWorkerJob(job, deps), runWorkerJob(job, deps)]);
    assert.equal(outcomes.filter((outcome) => outcome.status === "accepted").length, 1);
    assert.equal(readFileSync(marker, "utf8").trim().split("\n").length, 1, "exactly one worker spawn");
    assert.deepEqual(outcomes.find((outcome) => outcome.status === "rejected"), { status: "rejected", reason: "duplicate" });
    assert.equal((await runWorkerJob({ ...job, occurrenceId: "occ-2" }, deps)).status, "accepted");
  } finally {
    done();
  }
});

test("worker-run: budget denial leaves no claim behind", async () => {
  const { marker, deps, job, done } = setup(0);
  try {
    assert.equal((await runWorkerJob(job, deps)).reason, "budget_exhausted");
    assert.equal(existsSync(marker), false);
    deps.dailyInvocationLimit = 1;
    assert.equal((await runWorkerJob(job, deps)).status, "accepted");
  } finally {
    done();
  }
});

test("worker-run: completed result and duplicate survive reopening the profile DB", async () => {
  const { marker, deps, job, done, reopen } = setup();
  try {
    const first = await runWorkerJob(job, deps);
    const spawned = readFileSync(marker, "utf8");
    reopen();
    assert.deepEqual(deps.results.get(job.occurrenceId), first.row);
    assert.deepEqual(await runWorkerJob(job, deps), { status: "rejected", reason: "duplicate" });
    assert.equal(readFileSync(marker, "utf8"), spawned);
  } finally {
    done();
  }
});

test("worker-run: crash after committed claim blocks restart before budget or spawn", async () => {
  const { marker, deps, job, done, reopen, dbPath } = setup();
  try {
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { Store } from ${JSON.stringify(new URL("../dist/store.js", import.meta.url).href)};
      import { createResultsStore } from ${JSON.stringify(new URL("../dist/worker/results.js", import.meta.url).href)};
      const store = new Store(process.argv[1]);
      if (createResultsStore(store).claim("occ-1", 1000, 1) !== "claimed") process.exit(2);
      process.kill(process.pid, "SIGKILL");
    `, dbPath], { encoding: "utf8", timeout: 5000 });
    assert.equal(child.signal, "SIGKILL", child.stderr);
    reopen();
    assert.deepEqual(await runWorkerJob(job, deps), { status: "rejected", reason: "duplicate" });
    assert.equal(existsSync(marker), false);
    assert.equal(deps.results.get(job.occurrenceId), undefined);
    // The crashed attempt still consumed the day's single invocation.
    assert.equal((await runWorkerJob({ ...job, occurrenceId: "occ-2" }, deps)).reason, "budget_exhausted");
    assert.equal(existsSync(marker), false);
    deps.nowMs = () => 86_400_000;
    assert.equal((await runWorkerJob({ ...job, occurrenceId: "occ-2" }, deps)).status, "accepted");
  } finally {
    done();
  }
});

test("worker-run: runner failure remains non-retryable after restart", async () => {
  const { marker, deps, job, done, reopen, dbPath } = setup(2);
  try {
    const profile = deps.loadProfile;
    deps.loadProfile = () => ({ id: "fake", executablePath: "/no/such/worker", args: [] });
    await assert.rejects(runWorkerJob(job, deps), /ENOENT/);
    reopen();
    const reader = new Store(dbPath);
    try {
      assert.equal(reader.db.prepare("SELECT status FROM worker_claims WHERE occurrence_id = ?").get(job.occurrenceId).status, "interrupted");
    } finally {
      reader.close();
    }
    deps.loadProfile = profile;
    assert.deepEqual(await runWorkerJob(job, deps), { status: "rejected", reason: "duplicate" });
    assert.equal(existsSync(marker), false);
  } finally {
    done();
  }
});

test("worker-run: failure persisting a spawned result never releases its claim", async () => {
  const { marker, deps, job, done, reopen } = setup(2);
  try {
    deps.results.complete = () => { throw new Error("result write failed"); };
    await assert.rejects(runWorkerJob(job, deps), /result write failed/);
    const spawned = readFileSync(marker, "utf8");
    reopen();
    assert.deepEqual(await runWorkerJob(job, deps), { status: "rejected", reason: "duplicate" });
    assert.equal(readFileSync(marker, "utf8"), spawned);
    assert.equal(deps.results.get(job.occurrenceId), undefined);
  } finally {
    done();
  }
});

test("worker-run: concurrent processes sharing a profile spawn only once", { timeout: 10000 }, async () => {
  const { marker, deps, job, done, dbPath } = setup(2);
  const children = [];
  try {
    const source = `
      import { Store } from ${JSON.stringify(new URL("../dist/store.js", import.meta.url).href)};
      import { createResultsStore } from ${JSON.stringify(new URL("../dist/worker/results.js", import.meta.url).href)};
      import { runWorkerJob } from ${JSON.stringify(new URL("../dist/worker/run.js", import.meta.url).href)};
      const store = new Store(${JSON.stringify(dbPath)});
      process.once("message", async () => {
        const outcome = await runWorkerJob(${JSON.stringify(job)}, {
          ...${JSON.stringify(deps)}, results: createResultsStore(store),
          nowMs: () => 1000, loadProfile: () => (${JSON.stringify(deps.loadProfile())})
        });
        console.log(JSON.stringify({ outcome }));
        store.close();
        process.disconnect();
      });
      process.send("ready");
    `;
    const runs = [0, 1].map(() => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
      children.push(child);
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      const ready = new Promise((resolve, reject) => {
        child.once("message", resolve);
        child.once("error", reject);
        child.once("exit", () => reject(new Error(`child exited before ready: ${stderr}`)));
      });
      const finished = new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => {
          if (code !== 0) return reject(new Error(`child exit ${code}: ${stderr}`));
          try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
        });
      });
      return { ready, finished };
    });
    const finished = Promise.all(runs.map((run) => run.finished));
    await Promise.all(runs.map((run) => run.ready));
    for (const child of children) child.send("run");
    const outcomes = await finished;
    assert.equal(outcomes.filter(({ outcome }) => outcome.status === "accepted").length, 1);
    assert.deepEqual(outcomes.find(({ outcome }) => outcome.status === "rejected"), {
      outcome: { status: "rejected", reason: "duplicate" },
    });
    assert.equal(readFileSync(marker, "utf8").trim().split("\n").length, 1);
    // The duplicate spent none of the shared limit of 2; the third then exhausts it.
    assert.equal((await runWorkerJob({ ...job, occurrenceId: "occ-2" }, deps)).status, "accepted");
    assert.equal((await runWorkerJob({ ...job, occurrenceId: "occ-3" }, deps)).reason, "budget_exhausted");
  } finally {
    for (const child of children) child.kill("SIGKILL");
    done();
  }
});

test("worker-run: an interrupt write failure leaves the original claim blocking retries", async () => {
  const { deps, job, done, reopen } = setup(2);
  try {
    deps.results.complete = () => { throw new Error("result write failed"); };
    deps.results.interrupt = () => { throw new Error("interrupt write failed"); };
    await assert.rejects(runWorkerJob(job, deps), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors.map((item) => item.message), ["result write failed", "interrupt write failed"]);
      return true;
    });
    reopen();
    assert.deepEqual(await runWorkerJob(job, deps), { status: "rejected", reason: "duplicate" });
  } finally {
    done();
  }
});
