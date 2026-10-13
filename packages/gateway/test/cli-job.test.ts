import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { DeliveryRoute } from "pi-hermes-gateway-protocol";
import { startDaemon, type Daemon } from "../dist/daemon.js";
import { createFakeAdapter } from "../dist/fake-adapter.js";
import { ROUTE } from "./helpers.ts";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const ROUTE_B: DeliveryRoute = { ...ROUTE, chatId: "chat-2" };
// Far enough ahead that the in-process daemon's ticks never admit an occurrence during the test.
const FUTURE = "2099-01-01T12:00:00Z";

type CliResult = { status: number | null; stdout: string; stderr: string };

// The daemon's IPC server lives on this process's event loop, so the CLI child must be awaited, not spawnSync'd.
function runCli(profileDir: string, args: string[]): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, "--profile", profileDir, "job", ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI did not exit: job ${args.join(" ")}`));
    }, 10_000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

// config.json lists the routes the CLI may index; the daemon's own allowlist may be narrower.
function setup(t, { configuredRoutes = [ROUTE], daemonRoutes = configuredRoutes, daemon = true }: {
  configuredRoutes?: DeliveryRoute[]; daemonRoutes?: DeliveryRoute[]; daemon?: boolean;
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cli-job-"));
  const profileDir = join(dir, "profile");
  mkdirSync(profileDir, { mode: 0o700 });
  chmodSync(profileDir, 0o700);
  writeFileSync(join(profileDir, "config.json"), JSON.stringify({ routes: configuredRoutes }));
  const adapter = createFakeAdapter();
  const running: Daemon | undefined = daemon ? startDaemon({ profileDir, routes: daemonRoutes, adapter }) : undefined;
  t.after(() => {
    running?.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const run = (args: string[]) => runCli(profileDir, args);
  const create = (args: string[]) => run(["create", ...args]);
  const list = async () => {
    const result = await run(["list"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    return JSON.parse(result.stdout).jobs as Array<Record<string, unknown>>;
  };
  const storedJobIds = () => running!.gateway.store.listJobs().map((job) => job.job_id).sort();
  return { dir, profileDir, adapter, run, create, list, storedJobIds };
}

const JOB_ID = /^job_[0-9a-f]{24}\n$/;

test("cli-job: create prints the job id and list shows the created jobs", async (t) => {
  const { create, list, adapter, storedJobIds } = setup(t);
  assert.deepEqual(await list(), []);

  const once = await create(["--text", "hello once", "--at", FUTURE]);
  assert.equal(once.status, 0, once.stderr);
  assert.equal(once.stderr, "");
  assert.match(once.stdout, JOB_ID);
  const onceId = once.stdout.trim();

  const daily = await create(["--text", "hello daily", "--daily", "09:30", "--tz", "Europe/London", "--route", "0"]);
  assert.equal(daily.status, 0, daily.stderr);
  assert.match(daily.stdout, JOB_ID);
  const dailyId = daily.stdout.trim();
  assert.notEqual(dailyId, onceId);

  const jobs = await list();
  const byId = new Map(jobs.map((job) => [job.job_id, job]));
  assert.deepEqual([...byId.keys()].sort(), [onceId, dailyId].sort());
  const onceJob = byId.get(onceId)!;
  assert.equal(onceJob.kind, "static-text");
  assert.equal(onceJob.text, "hello once");
  assert.equal(onceJob.status, "active");
  assert.deepEqual(JSON.parse(onceJob.schedule_json as string), { type: "once", atUtc: FUTURE });
  assert.deepEqual(JSON.parse(onceJob.route_json as string), ROUTE);
  const dailyJob = byId.get(dailyId)!;
  assert.equal(dailyJob.text, "hello daily");
  assert.deepEqual(JSON.parse(dailyJob.schedule_json as string), { type: "daily", localTime: "09:30", timeZone: "Europe/London" });
  assert.deepEqual(JSON.parse(dailyJob.route_json as string), ROUTE);
  // The CLI output is the daemon's ledger, not a client-side echo.
  assert.deepEqual(storedJobIds(), [onceId, dailyId].sort());
  assert.equal(adapter.sent.length, 0);
});

test("cli-job: malformed operands are usage errors that never reach the daemon", async (t) => {
  const { run, create, list, storedJobIds } = setup(t);
  const cases: Array<[string[], RegExp]> = [
    [[], /usage: .* job create/],
    [["frobnicate"], /usage: .* job create/],
    [["list", "extra"], /unexpected argument extra/],
    [["list", "--text", "x"], /unknown option --text/],
    [["create"], /--text is required/],
    [["create", "--text"], /--text requires a value/],
    [["create", "--text", ""], /--text must be non-empty/],
    [["create", "--text", "x"], /one of --at or --daily with --tz is required/],
    [["create", "--text", "x", "--daily", "09:00"], /--daily requires --tz/],
    [["create", "--text", "x", "--tz", "UTC"], /--tz requires --daily/],
    [["create", "--text", "x", "--at", FUTURE, "--daily", "09:00", "--tz", "UTC"], /--at cannot be combined with --daily or --tz/],
    [["create", "--text", "x", "--at", FUTURE, "--at", FUTURE], /duplicate option --at/],
    [["create", "--text", "x", "--at", FUTURE, "--route", "x"], /--route must be a non-negative integer/],
    [["create", "--text", "x", "--at", FUTURE, "--route", "-1"], /--route must be a non-negative integer/],
    [["create", "--text", "x", "--at", FUTURE, "--route", "1"], /route index 1 is not configured \(1 configured\)/],
    [["create", "--text", "x", "--at", FUTURE, "--bogus", "y"], /unknown option --bogus/],
    [["create", "--text", "x", "--at", FUTURE, "extra"], /unexpected argument extra/],
  ];
  for (const [args, stderr] of cases) {
    const result = await run(args);
    assert.equal(result.status, 2, `${args.join(" ")}: ${result.stderr}`);
    assert.match(result.stderr, stderr, args.join(" "));
    assert.equal(result.stdout, "", args.join(" "));
  }
  // Well-formed operands with an invalid schedule value are the daemon's call, reported with its error code.
  const badAt = await create(["--text", "x", "--at", "tomorrow"]);
  assert.equal(badAt.status, 1, badAt.stderr);
  assert.match(badAt.stderr, /^invalid_body: once schedule atUtc/);
  assert.equal(badAt.stdout, "");
  const badTz = await create(["--text", "x", "--daily", "09:00", "--tz", "Mars/Olympus"]);
  assert.equal(badTz.status, 1, badTz.stderr);
  assert.match(badTz.stderr, /^invalid_body: daily timeZone/);
  assert.deepEqual(await list(), []);
  assert.deepEqual(storedJobIds(), []);
});

test("cli-job: a configured route the daemon does not authorise is rejected with invalid_route", async (t) => {
  const { create, list, storedJobIds, adapter } = setup(t, { configuredRoutes: [ROUTE, ROUTE_B], daemonRoutes: [ROUTE] });
  const rejected = await create(["--text", "to chat-2", "--at", FUTURE, "--route", "1"]);
  assert.equal(rejected.status, 1, rejected.stderr);
  assert.equal(rejected.stderr, "invalid_route: route is not authorised\n");
  assert.equal(rejected.stdout, "");
  assert.deepEqual(await list(), []);
  assert.deepEqual(storedJobIds(), []);

  // With more than one route configured the index must be explicit.
  const ambiguous = await create(["--text", "to whom", "--at", FUTURE]);
  assert.equal(ambiguous.status, 2, ambiguous.stderr);
  assert.match(ambiguous.stderr, /--route is required when 2 routes are configured/);
  assert.deepEqual(storedJobIds(), []);

  const accepted = await create(["--text", "to chat-1", "--at", FUTURE, "--route", "0"]);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.stdout, JOB_ID);
  const jobs = await list();
  assert.equal(jobs.length, 1);
  assert.deepEqual(JSON.parse(jobs[0]!.route_json as string), ROUTE);
  assert.equal(adapter.sent.length, 0);
});

test("cli-job: without a running daemon create and list exit nonzero with a clear message and create nothing", async (t) => {
  const { profileDir, run, create } = setup(t, { daemon: false });
  const missing = await create(["--text", "nobody home", "--at", FUTURE]);
  assert.equal(missing.status, 1, missing.stderr);
  assert.match(missing.stderr, /^gateway daemon is not running: cannot connect to .*gateway\.sock \(ENOENT\)\n$/);
  assert.equal(missing.stdout, "");
  const list = await run(["list"]);
  assert.equal(list.status, 1, list.stderr);
  assert.match(list.stderr, /^gateway daemon is not running/);
  assert.equal(list.stdout, "");
  // No ledger, lock or socket was created; the profile holds only its config.
  assert.deepEqual(readdirSync(profileDir), ["config.json"]);
  assert.equal(existsSync(join(profileDir, "gateway.sqlite")), false);

  // A stale socket file with nobody listening is the same failure, not a hang.
  writeFileSync(join(profileDir, "gateway.sock"), "");
  const stale = await create(["--text", "nobody home", "--at", FUTURE]);
  assert.equal(stale.status, 1, stale.stderr);
  assert.match(stale.stderr, /^gateway daemon is not running: cannot connect to .*gateway\.sock \(ECONNREFUSED\)\n$/);
  assert.equal(stale.stdout, "");
  assert.deepEqual(readdirSync(profileDir).sort(), ["config.json", "gateway.sock"]);
});

test("cli-job: a repeated --request-id replays the first job id instead of creating a second job", async (t) => {
  const { create, list, storedJobIds } = setup(t);
  const first = await create(["--text", "once only", "--at", FUTURE, "--request-id", "cli-job-dedup-1"]);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, JOB_ID);
  const jobId = first.stdout.trim();

  const repeat = await create(["--text", "once only", "--at", FUTURE, "--request-id", "cli-job-dedup-1"]);
  assert.equal(repeat.status, 0, repeat.stderr);
  assert.equal(repeat.stdout, first.stdout);
  assert.equal(repeat.stderr, "");
  assert.deepEqual(storedJobIds(), [jobId]);

  // The request log, not the body, decides: a changed body under the same id is still the first job.
  const changed = await create(["--text", "different text", "--daily", "08:00", "--tz", "UTC", "--request-id", "cli-job-dedup-1"]);
  assert.equal(changed.status, 0, changed.stderr);
  assert.equal(changed.stdout, first.stdout);
  const jobs = await list();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.text, "once only");

  const other = await create(["--text", "once only", "--at", FUTURE, "--request-id", "cli-job-dedup-2"]);
  assert.equal(other.status, 0, other.stderr);
  assert.match(other.stdout, JOB_ID);
  assert.notEqual(other.stdout, first.stdout);
  assert.deepEqual(storedJobIds(), [jobId, other.stdout.trim()].sort());

  // Without --request-id every invocation is a fresh request.
  const a = await create(["--text", "fresh", "--at", FUTURE]);
  const b = await create(["--text", "fresh", "--at", FUTURE]);
  assert.equal(a.status, 0, a.stderr);
  assert.equal(b.status, 0, b.stderr);
  assert.notEqual(a.stdout, b.stdout);
  assert.equal((await list()).length, 4);

  // An id outside the protocol pattern is the daemon's rejection, so no job is created for it.
  const malformed = await create(["--text", "x", "--at", FUTURE, "--request-id", "bad id"]);
  assert.equal(malformed.status, 1, malformed.stderr);
  assert.match(malformed.stderr, /^invalid_request_id: requestId must match/);
  assert.equal((await list()).length, 4);
});
