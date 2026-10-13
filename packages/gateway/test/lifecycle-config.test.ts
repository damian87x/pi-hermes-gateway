import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION } from "pi-hermes-gateway-protocol";
import { createAdapter } from "../dist/fake-adapter.js";
import { isSendAdapter, loadSendAdapter, sendIpc, startDaemon, TestClock, type FakeAdapter } from "../dist/index.js";
import { cleanup, ROUTE, tmpDir } from "./helpers.ts";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
// The module a profile's config.adapter.module would name; resolved from this test, never from a fixed machine path.
const fakeAdapterModule = fileURLToPath(new URL("../dist/fake-adapter.js", import.meta.url));

function profileDir(): string {
  const dir = tmpDir();
  chmodSync(dir, 0o700);
  return dir;
}

function writeConfig(dir: string, config: Record<string, unknown>): void {
  writeFileSync(join(dir, "config.json"), JSON.stringify({ routes: [ROUTE], ...config }), { mode: 0o600 });
}

type CliRun = { child: ChildProcess; output(): string; exited: Promise<number | null> };

function runCli(dir: string): CliRun {
  const child = spawn(process.execPath, [cliPath, "--profile", dir], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout?.on("data", (chunk: Uint8Array | string) => {
    out += String(chunk);
  });
  child.stderr?.on("data", (chunk: Uint8Array | string) => {
    out += String(chunk);
  });
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  return { child, output: () => out, exited };
}

async function waitFor(predicate: () => boolean, what: () => string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what()}`);
    await sleep(10);
  }
}

async function stopCli(run: CliRun): Promise<number | null> {
  if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill("SIGTERM");
  return run.exited;
}

type IpcResponse = { ok: boolean; body?: unknown; error?: { code: string; message: string } };

function ipc(sock: string, method: string, body: unknown, requestId: string): Promise<IpcResponse> {
  return sendIpc(sock, { protocolVersion: PROTOCOL_VERSION, requestId, method, body, expiresAt: Date.now() + 30_000 }) as Promise<IpcResponse>;
}

test("fake-adapter createAdapter loads through adapter-loader with a sinkPath config and refuses malformed config", async () => {
  const dir = profileDir();
  const sink = join(dir, "fake-sink.json");
  const adapter = (await loadSendAdapter(fakeAdapterModule, { sinkPath: sink }, dir)) as FakeAdapter;
  assert.equal(isSendAdapter(adapter), true);
  assert.equal(adapter.manifest.adapterId, "fake");
  assert.equal(adapter.sinkPath, sink);
  assert.equal(existsSync(sink), false, "the sink is written on send, not on load");
  adapter.send({ deliveryId: "dlv_sink", route: ROUTE, text: "to-sink" });
  assert.match(readFileSync(sink, "utf8"), /to-sink/);

  const bare = (await loadSendAdapter(fakeAdapterModule, null, dir)) as FakeAdapter;
  assert.equal(bare.manifest.adapterId, "fake");
  assert.equal(bare.sinkPath, null);

  for (const bad of ["x", 1, [], { sinkPath: 1 }, { sinkPath: "" }, { maxTextLength: "4096" }, { maxTextLength: 0 }, { token: "nope" }]) {
    assert.throws(() => createAdapter(bad), /fake adapter config/, JSON.stringify(bad));
  }
  cleanup(dir);
});

test("CLI loads config.adapter fake module with sinkPath and honors config.tickIntervalMs", async () => {
  const dir = profileDir();
  const sink = join(dir, "fake-sink.json");
  writeConfig(dir, { adapter: { module: fakeAdapterModule, config: { sinkPath: sink } }, tickIntervalMs: 100 });
  const run = runCli(dir);
  let code: number | null = null;
  try {
    await waitFor(() => run.output().includes("gateway listening"), () => `gateway listening: ${run.output()}`);
    const sock = join(dir, "gateway.sock");
    const enqueued = await ipc(sock, "delivery.enqueue", { route: ROUTE, text: "via-config-adapter", notAfter: Date.now() + 60_000 }, "cfg-enqueue");
    assert.equal(enqueued.ok, true, JSON.stringify(enqueued));
    assert.equal((enqueued.body as { status: string }).status, "accepted");
    assert.match(readFileSync(sink, "utf8"), /via-config-adapter/, "the loaded adapter writes the configured sink");

    // A once job a few hundred ms out is only delivered by the configured 100ms tick; the default 60s tick would not reach it here.
    const atUtc = new Date(Date.now() + 300).toISOString();
    const job = await ipc(sock, "job.create", { kind: "static-text", text: "tick-fired", route: ROUTE, schedule: { type: "once", atUtc } }, "cfg-job");
    assert.equal(job.ok, true, JSON.stringify(job));
    await waitFor(() => readFileSync(sink, "utf8").includes("tick-fired"), () => `100ms tick to deliver the once job: ${run.output()}`);
  } finally {
    code = await stopCli(run);
    cleanup(dir);
  }
  assert.equal(code, 0, run.output());
});

test("CLI refuses config.tickIntervalMs outside 1..60000 with exit 2 before starting; the boundaries start", async () => {
  for (const bad of [0, 60_001, -1, 1.5, "60", null, true]) {
    const dir = profileDir();
    writeConfig(dir, { tickIntervalMs: bad });
    const run = runCli(dir);
    const code = await run.exited;
    const label = `${JSON.stringify(bad)}: ${run.output()}`;
    assert.equal(code, 2, label);
    assert.match(run.output(), /tickIntervalMs must be an integer in 1\.\.60000/, label);
    assert.equal(run.output().includes("gateway listening"), false, label);
    assert.deepEqual(readdirSync(dir), ["config.json"], `refusal must touch no lock, ledger or socket: ${label}`);
    cleanup(dir);
  }
  for (const edge of [1, 60_000]) {
    const dir = profileDir();
    writeConfig(dir, { tickIntervalMs: edge });
    const run = runCli(dir);
    let code: number | null = null;
    try {
      await waitFor(() => run.output().includes("gateway listening"), () => `${edge}: ${run.output()}`);
    } finally {
      code = await stopCli(run);
      cleanup(dir);
    }
    assert.equal(code, 0, `${edge}: ${run.output()}`);
  }
});

test("no config.adapter keeps the fake adapter with no sink, in process and through the CLI", async () => {
  const dir = profileDir();
  const daemon = startDaemon({ profileDir: dir, routes: [ROUTE], clock: new TestClock(Date.UTC(2026, 0, 1, 10, 0, 0)), bindSocket: false });
  try {
    const adapter = daemon.adapter as FakeAdapter;
    assert.equal(adapter.manifest.adapterId, "fake");
    assert.equal(adapter.sinkPath, null);
    assert.deepEqual(adapter.sent, []);
  } finally {
    daemon.stop();
  }
  cleanup(dir);

  const cliDir = profileDir();
  writeConfig(cliDir, {});
  const run = runCli(cliDir);
  let code: number | null = null;
  try {
    await waitFor(() => run.output().includes("gateway listening"), () => `gateway listening: ${run.output()}`);
    const enqueued = await ipc(join(cliDir, "gateway.sock"), "delivery.enqueue", { route: ROUTE, text: "default-fake", notAfter: Date.now() + 60_000 }, "default-enqueue");
    assert.equal(enqueued.ok, true, JSON.stringify(enqueued));
    assert.equal((enqueued.body as { status: string }).status, "accepted", "the default fake adapter still accepts fake routes");
    // profile.lock is a SQLite database held in an exclusive transaction, so its -journal (or -wal/-shm) side files are lock artifacts, not a sink.
    const extras = readdirSync(cliDir).filter((name) => !name.startsWith("gateway.sqlite") && !name.startsWith("profile.lock") && !["config.json", "gateway.sock"].includes(name));
    assert.deepEqual(extras, [], "no sink file appears in the profile without config.adapter");
  } finally {
    code = await stopCli(run);
    cleanup(cliDir);
  }
  assert.equal(code, 0, run.output());
});
