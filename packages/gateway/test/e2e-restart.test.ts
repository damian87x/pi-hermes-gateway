import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createFakeAdapter, type FakeSendEnvelope } from "../dist/fake-adapter.js";
import { ROUTE } from "./helpers.ts";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const FAKE_MODULE = fileURLToPath(new URL("../dist/fake-adapter.js", import.meta.url));
const FAKE_URL = new URL("../dist/fake-adapter.js", import.meta.url).href;
const TICK_MS = 100;

type Run = {
  child: ChildProcess;
  output(): string;
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
};

async function waitFor(predicate: () => boolean, diagnostic: () => string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `timeout: ${diagnostic()}`);
    await sleep(20);
  }
}

function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "e2e-restart-"));
  const sinkPath = join(dir, "sink.json");
  const runs: Run[] = [];
  const sink = (): FakeSendEnvelope[] => existsSync(sinkPath) ? JSON.parse(readFileSync(sinkPath, "utf8")) : [];
  const configure = (module = FAKE_MODULE) => writeFileSync(join(dir, "config.json"), JSON.stringify({
    routes: [ROUTE], tickIntervalMs: TICK_MS, adapter: { module, config: { sinkPath } },
  }), { mode: 0o600 });
  configure();

  function launch(args: string[] = []): Run {
    const child = spawn(process.execPath, [CLI, "--profile", dir, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout!.on("data", (chunk) => { output += chunk; });
    child.stderr!.on("data", (chunk) => { output += chunk; });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    const run = { child, output: () => output, closed };
    runs.push(run);
    return run;
  }

  async function stop(run: Run, signal: NodeJS.Signals = "SIGTERM") {
    run.child.kill(signal);
    await waitFor(() => run.child.exitCode !== null || run.child.signalCode !== null, run.output);
    const result = await run.closed;
    assert.deepEqual(result, signal === "SIGTERM" ? { code: 0, signal: null } : { code: null, signal }, run.output());
  }

  async function start(): Promise<Run> {
    const run = launch();
    await waitFor(() => {
      assert.equal(run.child.exitCode, null, run.output());
      assert.equal(run.child.signalCode, null, run.output());
      return run.output().includes("gateway listening");
    }, run.output);
    return run;
  }

  async function create(text: string) {
    const due = Date.now() + 3_000;
    // This is the only socket client. Wait for close, not just the response, before any restart.
    const run = launch(["job", "create", "--text", text, "--at", new Date(due).toISOString()]);
    await waitFor(() => run.child.exitCode !== null || run.child.signalCode !== null, run.output);
    assert.deepEqual(await run.closed, { code: 0, signal: null }, run.output());
    assert.match(run.output(), /^job_[0-9a-f]{24}\n$/);
    return { jobId: run.output().trim(), due };
  }

  // Read-only ledger observations do not connect to IPC or invoke recovery in the parent process.
  function ledger() {
    const db = new DatabaseSync(join(dir, "gateway.sqlite"), { readOnly: true });
    try {
      return {
        deliveries: db.prepare("SELECT delivery_id, job_id, status FROM deliveries").all(),
        audit: db.prepare("SELECT kind, payload_json FROM audit").all(),
      };
    } finally {
      db.close();
    }
  }

  t.after(async () => {
    for (const run of runs) {
      if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill("SIGKILL");
      await run.closed;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, sinkPath, sink, configure, start, stop, create, ledger };
}

test("fake sink retains sends across adapter instances so restarts cannot hide duplicates", (t) => {
  const { sinkPath, sink } = setup(t);
  const envelope = { deliveryId: "dlv_duplicate", route: ROUTE, text: "duplicate probe" };
  createFakeAdapter({ sinkPath }).send(envelope);
  const restarted = createFakeAdapter({ sinkPath });
  assert.deepEqual(restarted.sent, [], "sent remains local to the adapter instance");
  restarted.send(envelope);
  assert.deepEqual(sink(), [envelope, envelope], "a duplicate across restart must remain visible in the sink");
  restarted.send({ ...envelope, deliveryId: "dlv_next" });
  assert.deepEqual(sink(), [envelope, envelope, { ...envelope, deliveryId: "dlv_next" }]);
  assert.equal(restarted.sent.length, 2);
});

test("scheduled message is delivered exactly once after the daemon process is restarted with no client connected", { timeout: 30_000 }, async (t) => {
  const { sink, start, stop, create, ledger } = setup(t);
  const first = await start();
  const { jobId, due } = await create("restart-once");
  await stop(first);
  assert.ok(Date.now() < due, "SIGTERM must finish before the job is due");
  assert.deepEqual(sink(), []);

  const second = await start();
  assert.notEqual(second.child.pid, first.child.pid);
  await waitFor(() => sink().length > 0, second.output);
  assert.ok(Date.now() >= due);
  await sleep(TICK_MS * 5);
  assert.equal(sink().length, 1);
  assert.equal(sink()[0]!.text, "restart-once");
  assert.deepEqual(sink()[0]!.route, ROUTE);
  assert.deepEqual(ledger().deliveries.map((row) => ({ ...row })), [
    { delivery_id: sink()[0]!.deliveryId, job_id: jobId, status: "accepted" },
  ]);
  await stop(second);

  const third = await start();
  assert.notEqual(third.child.pid, second.child.pid);
  await sleep(TICK_MS * 5);
  assert.equal(sink().length, 1, "startup and subsequent ticks must not redeliver");
  assert.equal(ledger().deliveries.length, 1);
  await stop(third);
});

test("SIGKILL while dispatching recovers as commit-unknown without a second sink entry", { timeout: 40_000 }, async (t) => {
  for (const observed of [false, true]) {
    await t.test(observed ? "after fake sink write" : "before fake sink write", async (t) => {
      const { dir, sink, configure, start, stop, create, ledger } = setup(t);
      // A local module stalls the fake send before the receipt, with or without an observed send.
      // No production crash knob or provider is needed; the marker is emitted only inside send.
      const stalledModule = join(dir, "stalled-fake.mjs");
      writeFileSync(stalledModule, `
import { createAdapter as createFake } from ${JSON.stringify(FAKE_URL)};
export function createAdapter(config) {
  const adapter = createFake(config);
  const send = adapter.send.bind(adapter);
  adapter.send = (envelope) => {
    ${observed ? "send(envelope);" : ""}
    process.stdout.write("dispatch-stalled\\n");
    return new Promise(() => {});
  };
  return adapter;
}
`);
      configure(stalledModule);
      const first = await start();
      const { jobId } = await create("crash-once");
      await waitFor(() => first.output().includes("dispatch-stalled"), first.output);
      const before = ledger().deliveries;
      assert.equal(before.length, 1);
      assert.equal(before[0]!.job_id, jobId);
      assert.equal(before[0]!.status, "dispatching");
      assert.equal(sink().length, Number(observed));
      await stop(first, "SIGKILL");

      configure();
      const second = await start();
      await sleep(TICK_MS * 5);
      const recovered = ledger();
      assert.equal(recovered.deliveries.length, 1);
      assert.equal(recovered.deliveries[0]!.status, "commit-unknown");
      assert.ok(recovered.audit.some((row) => row.kind === "crash.recover" && JSON.parse(String(row.payload_json)).deliveryId === before[0]!.delivery_id));
      assert.equal(sink().length, Number(observed), "an ambiguous send is never retried");
      await stop(second);

      const third = await start();
      await sleep(TICK_MS * 5);
      assert.equal(sink().length, Number(observed), "another restart must not retry commit-unknown");
      assert.equal(ledger().deliveries[0]!.status, "commit-unknown");
      await stop(third);
    });
  }
});
