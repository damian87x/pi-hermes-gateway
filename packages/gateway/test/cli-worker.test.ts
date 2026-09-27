import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { handle, openTestGw, ROUTE } from "./helpers.ts";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const HOOK = fileURLToPath(new URL("./cli-worker-profile-hook.mjs", import.meta.url));

// argv after node: [marker, mode, ...worker CLI flags]
const FAKE_WORKER = `
const { appendFileSync } = require("node:fs");
const [marker, mode] = process.argv.slice(2);
appendFileSync(marker, process.pid + "\\n");
if (mode === "fail") process.exit(3);
if (mode === "hang") setInterval(() => {}, 1000);
else if (mode === "big") process.stdout.write("0123456789".repeat(60_000) + "BIG-TAIL\\n");
else setTimeout(() => process.stdout.write("worker ok\\n"), mode === "slow" ? 500 : 0);
`;

function setup(t, mode = "ok") {
  const dir = mkdtempSync(join(tmpdir(), "cli-worker-"));
  const profileDir = join(dir, "profile");
  mkdirSync(profileDir, { mode: 0o700 });
  chmodSync(profileDir, 0o700);
  const script = join(dir, "fake-worker.cjs");
  writeFileSync(script, FAKE_WORKER);
  const marker = join(dir, "marker");
  t.after(() => {
    // Workers run detached in their own process group; reap every one that started.
    const pids = existsSync(marker) ? readFileSync(marker, "utf8").trim().split("\n").filter(Boolean) : [];
    for (const pid of pids) {
      try {
        process.kill(-Number(pid), "SIGKILL");
      } catch {
        // already gone
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const env = (profile = [process.execPath, script, marker, mode], extra = {}) => ({
    ...process.env,
    CLI_WORKER_TEST_PROFILE: JSON.stringify(profile),
    ...extra,
  });
  const argv = (args) => ["--import", HOOK, CLI, "--profile", profileDir, "worker", ...args];
  const run = (args, profile) => spawnSync(process.execPath, argv(args), { encoding: "utf8", env: env(profile), timeout: 10_000 });
  // Piped CLI run that reports on close, so every stdout byte is collected; readDelayMs defers reading.
  const runPiped = (args, { readDelayMs = 0, closeStdout = false } = {}) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, argv(args), { env: env(), stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("CLI did not close"));
    }, 10_000);
    if (closeStdout) child.stdout.destroy();
    else setTimeout(() => child.stdout.on("data", (chunk) => stdout.push(chunk)), readDelayMs);
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout: Buffer.concat(stdout).toString("utf8"), stderr });
    });
  });
  const spawns = () => (existsSync(marker) ? readFileSync(marker, "utf8").trim().split("\n").length : 0);
  const claims = () => {
    const db = new DatabaseSync(join(profileDir, "gateway.sqlite"), { readOnly: true });
    try {
      return db.prepare("SELECT occurrence_id, status FROM worker_claims ORDER BY rowid").all().map((row) => ({ ...row }));
    } finally {
      db.close();
    }
  };
  const completedResult = (occurrenceId) => {
    const db = new DatabaseSync(join(profileDir, "gateway.sqlite"), { readOnly: true });
    try {
      const row = db.prepare("SELECT result_json, accepted_at_ms FROM worker_claims WHERE occurrence_id = ? AND status = 'completed'").get(occurrenceId);
      return { occurrenceId, value: JSON.parse(row.result_json), acceptedAtMs: row.accepted_at_ms };
    } finally {
      db.close();
    }
  };
  return { dir, profileDir, marker, env, argv, run, runPiped, spawns, claims, completedResult };
}

const outcome = (result) => JSON.parse(result.stdout);
const BIG_TEXT = `${"0123456789".repeat(60_000)}BIG-TAIL`;
const exhausted = { status: "rejected", reason: "budget_exhausted", message: "daily invocation budget exhausted" };

// These CLI runs use the real clock; keep a sequence from straddling UTC midnight.
async function avoidUtcMidnight() {
  const untilMidnight = 86_400_000 - (Date.now() % 86_400_000);
  if (untilMidnight < 15_000) await sleep(untilMidnight + 100);
}

test("cli-worker: rejects extra arguments and job-supplied executables before admission", (t) => {
  const { profileDir, run, spawns } = setup(t);
  for (const args of [["report", "occ-1", "/bin/true"], ["report", "occ-1", "--executablePath=/bin/true"], ["report"], ["report", "--x"]]) {
    const result = run(args);
    assert.equal(result.status, 2, `${args.join(" ")}: ${result.stderr}`);
    assert.match(result.stderr, /usage: .* worker <profile-id> <occurrence-id>/);
  }
  assert.equal(existsSync(join(profileDir, "gateway.sqlite")), false);
  assert.equal(spawns(), 0);
});

test("cli-worker: an unsafe profile directory is refused before opening the ledger or spawning", async (t) => {
  await avoidUtcMidnight();
  const { profileDir, run, spawns, claims } = setup(t);
  chmodSync(profileDir, 0o777);
  const unsafe = run(["report", "occ-1"]);
  assert.equal(unsafe.status, 1, unsafe.stderr);
  assert.match(unsafe.stderr, /profile directory mode must be 0700/);
  assert.equal(unsafe.stdout, "");
  assert.equal(existsSync(join(profileDir, "gateway.sqlite")), false);
  assert.equal(spawns(), 0);
  chmodSync(profileDir, 0o700);
  const accepted = run(["report", "occ-1"]);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(outcome(accepted).status, "accepted");
  assert.deepEqual(claims(), [{ occurrence_id: "occ-1", status: "completed" }]);
  assert.equal(spawns(), 1);
});

test("cli-worker: unknown profile is rejected without consuming the daily invocation", async (t) => {
  await avoidUtcMidnight();
  const { run, spawns, claims } = setup(t);
  const missing = run(["unknown", "occ-1"]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /unknown worker profile id "unknown"/);
  assert.deepEqual(claims(), []);
  const accepted = run(["report", "occ-1"]);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(outcome(accepted).status, "accepted");
  assert.equal(spawns(), 1);
});

test("cli-worker: inherited registry names are unknown profiles and spend nothing", async (t) => {
  await avoidUtcMidnight();
  const { run, spawns, claims } = setup(t);
  for (const profileId of ["__proto__", "constructor"]) {
    const result = run([profileId, `occ-${profileId}`]);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, new RegExp(`unknown worker profile id "${profileId}"`));
    assert.deepEqual(claims(), []);
  }
  assert.equal(spawns(), 0);
  const accepted = run(["report", "occ-1"]);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(outcome(accepted).status, "accepted");
  assert.deepEqual(claims(), [{ occurrence_id: "occ-1", status: "completed" }]);
  assert.equal(spawns(), 1);
});

test("cli-worker: the command is the first positional; `worker approve ID` never approves", (t) => {
  const { profileDir, argv, env, spawns, claims } = setup(t);
  const { gw, clock } = openTestGw({ dir: profileDir });
  const created = handle(gw, "job.create", {
    kind: "static-text", text: "needs-ok", route: ROUTE,
    schedule: { type: "once", atUtc: "2026-01-01T12:00:00.000Z" }, requireApproval: true,
  }, clock.nowMs());
  gw.close();
  assert.equal(created.ok, true);
  const jobId = created.body.jobId;
  const jobStatus = () => {
    const db = new DatabaseSync(join(profileDir, "gateway.sqlite"), { readOnly: true });
    try {
      return db.prepare("SELECT status FROM jobs WHERE job_id = ?").get(jobId).status;
    } finally {
      db.close();
    }
  };
  const worker = spawnSync(process.execPath, argv(["approve", jobId]), { encoding: "utf8", env: env(), timeout: 10_000 });
  assert.equal(worker.status, 1, worker.stderr);
  assert.match(worker.stderr, /unknown worker profile id "approve"/);
  assert.doesNotMatch(worker.stderr, /approved/);
  assert.equal(jobStatus(), "pending-approval");
  assert.deepEqual(claims(), []);
  assert.equal(spawns(), 0);
  // The intended approve form still works.
  const approve = spawnSync(process.execPath, [CLI, "--profile", profileDir, "approve", jobId], { encoding: "utf8", timeout: 10_000 });
  assert.equal(approve.status, 0, approve.stderr);
  assert.match(approve.stderr, /approved job .* -> active/);
  assert.equal(jobStatus(), "active");
  assert.deepEqual(claims(), []);
});

test("cli-worker: separate processes reject a repeated occurrence and a second occurrence the same UTC day", async (t) => {
  await avoidUtcMidnight();
  const { run, spawns, claims } = setup(t);
  const first = run(["report", "occ-1"]);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(outcome(first).row.value, { kind: "ok", text: "worker ok" });
  const repeat = run(["report", "occ-1"]);
  assert.equal(repeat.status, 1);
  assert.deepEqual(outcome(repeat), { status: "rejected", reason: "duplicate" });
  const other = run(["report", "occ-2"]);
  assert.equal(other.status, 1);
  assert.deepEqual(outcome(other), exhausted);
  assert.equal(spawns(), 1);
  assert.deepEqual(claims(), [{ occurrence_id: "occ-1", status: "completed" }]);
});

test("cli-worker: a failing worker still consumes the daily invocation", async (t) => {
  await avoidUtcMidnight();
  const { run, spawns } = setup(t, "fail");
  const first = run(["report", "occ-1"]);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(outcome(first).row.value, { kind: "rejected", reason: "exit", code: 3 });
  assert.deepEqual(outcome(run(["report", "occ-2"])), exhausted);
  assert.equal(spawns(), 1);
});

test("cli-worker: a spawn error still consumes the daily invocation", async (t) => {
  await avoidUtcMidnight();
  const { dir, run, claims } = setup(t);
  const missing = [join(dir, "no-such-worker")];
  const first = run(["report", "occ-1"], missing);
  assert.equal(first.status, 1);
  assert.match(first.stderr, /ENOENT/);
  assert.deepEqual(outcome(run(["report", "occ-2"])), exhausted);
  assert.deepEqual(claims(), [{ occurrence_id: "occ-1", status: "interrupted" }]);
});

test("cli-worker: a CLI killed mid-run still consumes the daily invocation", { timeout: 15_000 }, async (t) => {
  await avoidUtcMidnight();
  const { marker, env, argv, run, spawns, claims } = setup(t, "hang");
  const child = spawn(process.execPath, argv(["report", "occ-1"]), { env: env(), stdio: "ignore" });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  t.after(() => child.kill("SIGKILL"));
  const deadline = Date.now() + 10_000;
  while (!existsSync(marker) || !readFileSync(marker, "utf8").endsWith("\n")) {
    assert.ok(Date.now() < deadline, "worker never started");
    await sleep(20);
  }
  child.kill("SIGKILL");
  await exited;
  assert.deepEqual(claims(), [{ occurrence_id: "occ-1", status: "claimed" }]);
  assert.deepEqual(outcome(run(["report", "occ-2"])), exhausted);
  assert.equal(spawns(), 1);
});

for (const readDelayMs of [0, 1_000]) {
  test(`cli-worker: a 600KB result reaches piped stdout whole (read delay ${readDelayMs}ms)`, { timeout: 15_000 }, async (t) => {
    await avoidUtcMidnight();
    const { runPiped, spawns, completedResult } = setup(t, "big");
    const result = await runPiped(["report", "occ-1"], { readDelayMs });
    assert.equal(result.code, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /gateway listening/);
    assert.ok(result.stdout.endsWith("}\n"), `stdout length ${result.stdout.length}`);
    assert.equal(result.stdout.indexOf("\n"), result.stdout.length - 1);
    const printed = outcome(result);
    assert.equal(printed.row.value.text, BIG_TEXT);
    assert.deepEqual(printed, { status: "accepted", row: completedResult("occ-1") });
    assert.equal(spawns(), 1);
  });
}

test("cli-worker: a closed stdout reader fails the CLI but keeps the completed claim", { timeout: 15_000 }, async (t) => {
  await avoidUtcMidnight();
  const { run, runPiped, spawns, claims, completedResult } = setup(t, "big");
  const result = await runPiped(["report", "occ-1"], { closeStdout: true });
  assert.notEqual(result.code, 0, result.stderr);
  assert.match(result.stderr, /EPIPE/);
  assert.deepEqual(claims(), [{ occurrence_id: "occ-1", status: "completed" }]);
  assert.equal(completedResult("occ-1").value.text, BIG_TEXT);
  const repeat = run(["report", "occ-1"]);
  assert.deepEqual(outcome(repeat), { status: "rejected", reason: "duplicate" });
  assert.equal(spawns(), 1);
});

test("cli-worker: finite CLI errors keep their status and never fall through to the daemon", (t) => {
  const { profileDir } = setup(t);
  const cli = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", timeout: 10_000 });
  const cases = [
    [[], 2, /usage: /],
    [["--profile", profileDir, "approve"], 2, /usage: .* approve <id>/],
    [["--profile", profileDir, "approve", "missing"], 2, /missing gateway.sqlite/],
    [["--profile", profileDir, "--restore", "b", "--resume-dispatch"], 2, /cannot be combined/],
    [["--profile", profileDir], 2, /missing profile config.json/],
  ];
  for (const [args, status, stderr] of cases) {
    const result = cli(args);
    assert.equal(result.status, status, `${args.join(" ")}: ${result.stderr}`);
    assert.match(result.stderr, stderr);
    assert.doesNotMatch(result.stderr, /gateway listening/);
  }
  const { gw } = openTestGw({ dir: profileDir });
  gw.close();
  const unknown = cli(["--profile", profileDir, "approve", "no-such-id"]);
  assert.equal(unknown.status, 1, unknown.stderr);
  assert.doesNotMatch(unknown.stderr, /approved|gateway listening/);
  assert.equal(existsSync(join(profileDir, "gateway.sock")), false);
});

test("cli-worker: simultaneous independent CLI processes spawn at most one worker per day", { timeout: 20_000 }, async (t) => {
  await avoidUtcMidnight();
  const { dir, env, argv, spawns, claims } = setup(t, "slow");
  const barrier = join(dir, "barrier");
  mkdirSync(barrier);
  const count = 4;
  const runs = Array.from({ length: count }, (_, i) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, argv(["report", `occ-${i}`]), {
      env: env(undefined, { CLI_WORKER_TEST_BARRIER: JSON.stringify({ dir: barrier, count }) }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  }));
  const results = await Promise.all(runs);
  for (const result of results) assert.notEqual(result.stdout, "", result.stderr);
  const outcomes = results.map(outcome);
  assert.equal(outcomes.filter((o) => o.status === "accepted").length, 1, JSON.stringify(outcomes));
  assert.deepEqual(outcomes.filter((o) => o.status !== "accepted"), Array(count - 1).fill(exhausted));
  assert.equal(spawns(), 1);
  assert.equal(claims().length, 1);
});
