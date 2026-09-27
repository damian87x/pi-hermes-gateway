import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { SCHEMA_VERSION, Store } from "../dist/store.js";
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
  const { run, spawns, claims } = setup(t, "fail");
  const first = run(["report", "occ-1"]);
  assert.equal(first.status, 1, first.stderr);
  assert.equal(first.stdout, "");
  assert.match(first.stderr, /worker did not complete/);
  assert.deepEqual(claims(), [{ occurrence_id: "occ-1", status: "interrupted" }]);
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

test("cli-worker: a CLI whose ledger cannot be opened exits 1 with a diagnostic, not a stack", (t) => {
  const { profileDir, argv, env, spawns } = setup(t);
  writeFileSync(join(profileDir, "gateway.sqlite"), "x".repeat(4096), { mode: 0o600 });
  const worker = spawnSync(process.execPath, argv(["report", "occ-1"]), { encoding: "utf8", env: env(), timeout: 10_000 });
  const approve = spawnSync(process.execPath, [CLI, "--profile", profileDir, "approve", "job-1"], { encoding: "utf8", timeout: 10_000 });
  for (const result of [worker, approve]) {
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stderr, "file is not a database\n");
    assert.equal(result.stdout, "");
  }
  assert.equal(spawns(), 0);
  assert.equal(existsSync(join(profileDir, "gateway.sock")), false);
});

test("cli-worker: a newer ledger schema is reported, not masked by closing the store twice", (t) => {
  const { profileDir, argv, env, spawns } = setup(t);
  const db = new DatabaseSync(join(profileDir, "gateway.sqlite"));
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
  db.close();
  const worker = spawnSync(process.execPath, argv(["report", "occ-1"]), { encoding: "utf8", env: env(), timeout: 10_000 });
  const approve = spawnSync(process.execPath, [CLI, "--profile", profileDir, "approve", "job-1"], { encoding: "utf8", timeout: 10_000 });
  for (const result of [worker, approve]) {
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stderr, `schema version ${SCHEMA_VERSION + 1} is newer than binary ${SCHEMA_VERSION}\n`);
    assert.equal(result.stdout, "");
  }
  assert.equal(spawns(), 0);
});

const sqliteExec = DatabaseSync.prototype.exec;

// Capture every connection a Store constructor opens, and each attempt to enable WAL.
function instrumentStoreInit(t, { onWal = (run) => run(), onExec = (sql, run) => run() } = {}) {
  const handles = new Set();
  const walAttempts = [];
  t.mock.method(DatabaseSync.prototype, "exec", function (sql) {
    handles.add(this);
    const run = (text = sql) => sqliteExec.call(this, text);
    if (!/^PRAGMA journal_mode = WAL/.test(sql)) return onExec(sql, run);
    const attempt = { atMs: performance.now() };
    walAttempts.push(attempt);
    try {
      return onWal(run, walAttempts.length);
    } catch (err) {
      attempt.error = { code: err.code, errcode: err.errcode, errstr: err.errstr, message: err.message };
      throw err;
    }
  });
  return { handles, walAttempts };
}

function rollbackJournalDb(t) {
  const dir = mkdtempSync(join(tmpdir(), "store-wal-init-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "gateway.sqlite");
  const blocker = new DatabaseSync(path);
  t.after(() => blocker.close());
  blocker.exec("CREATE TABLE held(x); BEGIN IMMEDIATE; INSERT INTO held VALUES(1);");
  // Bypasses instrumentation, which only observes Store connections.
  const release = () => sqliteExec.call(blocker, "ROLLBACK");
  return { path, release };
}

test("store: WAL initialization retries a real SQLITE_BUSY and then opens normally", (t) => {
  const { path, release } = rollbackJournalDb(t);
  let busyTimeoutSet = 0;
  const { handles, walAttempts } = instrumentStoreInit(t, {
    // First attempt: no busy wait, so SQLite itself reports the held lock at once.
    onExec: (sql, run) => (/^PRAGMA busy_timeout/.test(sql) && busyTimeoutSet++ === 0 ? run("PRAGMA busy_timeout = 0") : run()),
    onWal: (run, attempt) => {
      try {
        return run();
      } finally {
        if (attempt === 1) release();
      }
    },
  });
  const store = new Store(path);
  t.mock.restoreAll();
  try {
    assert.deepEqual(walAttempts.map((a) => a.error), [
      { code: "ERR_SQLITE_ERROR", errcode: 5, errstr: "database is locked", message: "database is locked" },
      undefined,
    ]);
    assert.deepEqual([...handles], [store.db]);
    assert.equal(store.db.isTransaction, false);
    assert.equal(store.db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
    assert.equal(store.db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
    assert.equal(store.db.prepare("PRAGMA busy_timeout").get().timeout, 5000);
    store.migrate();
    assert.equal(store.userVersion(), SCHEMA_VERSION);
  } finally {
    store.close();
  }
});

test("store: persistent WAL contention fails within the init budget and closes the handle", { timeout: 15_000 }, (t) => {
  const { path } = rollbackJournalDb(t);
  const { handles, walAttempts } = instrumentStoreInit(t);
  const startedMs = performance.now();
  assert.throws(() => new Store(path), (err) => err.errcode === 5 && err.message === "database is locked");
  const elapsedMs = performance.now() - startedMs;
  t.mock.restoreAll();
  assert.ok(elapsedMs >= 4_900 && elapsedMs < 7_000, `elapsed ${elapsedMs}ms`);
  // Retries sleep between attempts instead of spinning. A starved scheduler may spend the whole
  // budget after the first BUSY, so one attempt is valid; the busy-then-success test proves retry.
  assert.ok(walAttempts.length >= 1 && walAttempts.length <= 5_000 / 20, `${walAttempts.length} attempts`);
  assert.equal(handles.size, 1);
  for (const db of handles) assert.equal(db.isOpen, false);
});

test("store: non-busy WAL initialization errors fail at once and close the handle", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "store-wal-init-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const notDb = join(dir, "not-a-db.sqlite");
  writeFileSync(notDb, "x".repeat(4096));
  const real = instrumentStoreInit(t);
  assert.throws(() => new Store(notDb), (err) => err.errcode === 26 && err.message === "file is not a database");
  t.mock.restoreAll();
  assert.equal(real.walAttempts.length, 1);
  for (const db of real.handles) assert.equal(db.isOpen, false);

  // SQLITE_LOCKED, BUSY_SNAPSHOT, generic errors and "locked" messages are not contention to wait out.
  const errors = [
    Object.assign(new Error("database table is locked"), { code: "ERR_SQLITE_ERROR", errcode: 6 }),
    Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR", errcode: 517 }),
    Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR" }),
    new Error("database is locked"),
  ];
  for (const [i, thrown] of errors.entries()) {
    const { handles, walAttempts } = instrumentStoreInit(t, { onWal: () => { throw thrown; } });
    assert.throws(() => new Store(join(dir, `synthetic-${i}.sqlite`)), (err) => err === thrown);
    t.mock.restoreAll();
    assert.equal(walAttempts.length, 1, thrown.message);
    assert.equal(handles.size, 1);
    for (const db of handles) assert.equal(db.isOpen, false);
  }

  const late = new Error("foreign keys unavailable");
  const { handles } = instrumentStoreInit(t, { onExec: (sql, run) => (/^PRAGMA foreign_keys/.test(sql) ? (() => { throw late; })() : run()) });
  assert.throws(() => new Store(join(dir, "late.sqlite")), (err) => err === late);
  t.mock.restoreAll();
  assert.equal(handles.size, 1);
  for (const db of handles) assert.equal(db.isOpen, false);
});

test("store: close after migrate rejected a newer schema keeps the original error", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "store-wal-init-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, "gateway.sqlite"));
  store.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
  assert.throws(() => store.migrate(), /is newer than binary/);
  store.close();
});

// One round: four independent CLI processes, one previously nonexistent ledger, released together.
async function concurrentFreshProfileRound(t, round, children) {
  await avoidUtcMidnight();
  const { dir, profileDir, env, argv, spawns, claims } = setup(t, "slow");
  const barrier = join(dir, "barrier");
  mkdirSync(barrier);
  const count = 4;
  const results = await Promise.all(Array.from({ length: count }, (_, i) => new Promise((resolve) => {
    const child = spawn(process.execPath, argv(["report", `occ-${i}`]), {
      env: env(undefined, { CLI_WORKER_TEST_BARRIER: JSON.stringify({ dir: barrier, count }) }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(child);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 15_000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (err) => { stderr += `spawn error: ${err.message}`; });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      children.delete(child);
      resolve({ occurrenceId: `occ-${i}`, code, signal, timedOut, stdout, stderr });
    });
  })));
  const details = `round ${round}: ${JSON.stringify(results)}`;
  for (const result of results) {
    assert.ok(/^\{.*\}\n$/.test(result.stdout), `incomplete JSON; ${details}`);
  }
  const accepted = results.filter((r) => JSON.parse(r.stdout).status === "accepted");
  assert.equal(accepted.length, 1, details);
  assert.equal(accepted[0].code, 0, details);
  for (const rejected of results.filter((r) => r !== accepted[0])) {
    assert.deepEqual(JSON.parse(rejected.stdout), exhausted, details);
    assert.equal(rejected.code, 1, details);
  }
  assert.equal(spawns(), 1, details);
  assert.deepEqual(claims(), [{ occurrence_id: accepted[0].occurrenceId, status: "completed" }], details);
  const db = new DatabaseSync(join(profileDir, "gateway.sqlite"), { readOnly: true });
  try {
    assert.equal(db.prepare("PRAGMA journal_mode").get().journal_mode, "wal", details);
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION, details);
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok", details);
  } finally {
    db.close();
  }
}

// SIGKILL every still-open CLI child and wait, at most graceMs, until each has closed (been reaped).
// Resolves to the number still open rather than throwing, so later fixture hooks still reap workers.
async function killAndReap(children, graceMs = 5_000) {
  let open = children.size;
  const closed = [...children].map((child) => new Promise((resolve) => {
    child.once("close", () => {
      open -= 1;
      resolve();
    });
    child.kill("SIGKILL");
  }));
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, graceMs);
    Promise.all(closed).then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
  return open;
}

test("cli-worker: parent-timeout teardown kills and reaps hung CLI children, within a bound", { timeout: 15_000 }, async (t) => {
  await avoidUtcMidnight();
  // The state a timed-out round leaves: live CLI children, each blocked on a hung detached worker.
  const children = new Set();
  t.after(() => {
    for (const child of children) child.kill("SIGKILL");
  });
  const closes = [];
  for (const fixture of [setup(t, "hang"), setup(t, "hang")]) {
    const child = spawn(process.execPath, fixture.argv(["report", "occ-1"]), { env: fixture.env(), stdio: "ignore" });
    children.add(child);
    closes.push(new Promise((resolve) => child.once("close", () => {
      children.delete(child);
      resolve();
    })));
    const deadline = Date.now() + 10_000;
    while (!existsSync(fixture.marker) || !readFileSync(fixture.marker, "utf8").endsWith("\n")) {
      assert.ok(Date.now() < deadline, "worker never started");
      await sleep(20);
    }
    assert.equal(fixture.spawns(), 1);
  }
  assert.equal(children.size, 2);
  const pids = [...children].map((child) => child.pid);
  assert.equal(await killAndReap(children), 0);
  assert.equal(children.size, 0);
  await Promise.all(closes);
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });

  // A child that never closes bounds the wait instead of hanging cleanup.
  const stuck = Object.assign(new EventEmitter(), { kill: () => true });
  const startedMs = performance.now();
  assert.equal(await killAndReap(new Set([stuck]), 50), 1);
  assert.ok(performance.now() - startedMs < 1_000);
});

test("cli-worker: simultaneous independent CLI processes on a fresh profile spawn exactly one worker per day", { timeout: 240_000 }, async (t) => {
  const children = new Set();
  // A per-child deadline kills stragglers; on a timed-out test, reap them before fixtures are removed.
  t.after(async () => {
    const open = await killAndReap(children);
    if (open > 0) t.diagnostic(`${open} CLI children still open after SIGKILL`);
  });
  for (let round = 1; round <= 50; round += 1) await concurrentFreshProfileRound(t, round, children);
});
