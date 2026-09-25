import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ISOLATION_FLAGS, runWorker } from "../dist/worker/runner.js";

const FAKE_CHILD = `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const mode = process.env.FAKE_MODE;
const out = process.env.FAKE_OUT;
if (mode === "argv") { process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() })); }
else if (mode === "hang") {
  const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  writeFileSync(out, String(g.pid));
  setInterval(() => {}, 1000);
}
else if (mode === "big") { process.stdout.write("x".repeat(4096)); setInterval(() => {}, 1000); }
else if (mode === "binary") { process.stdout.write(Buffer.from([0xff, 0xfe, 0x00])); }
else if (mode === "empty") { process.stdout.write("   \\n"); }
else if (mode === "fail") { process.stdout.write("partial"); process.exit(3); }
else { process.stdout.write("report ok\\n"); }
`;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "w1c-"));
  const script = join(dir, "fake-pi.cjs");
  writeFileSync(script, FAKE_CHILD);
  const cwd = mkdtempSync(join(tmpdir(), "w1c-cwd-"));
  const base = {
    cliPath: process.execPath,
    cliPrefixArgs: [script],
    provider: "fake",
    model: "fake-model",
    prompt: "summarize",
    cwd,
    timeoutMs: 5_000,
    maxOutputBytes: 1024,
  };
  const done = () => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  };
  return { dir, base, done };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("worker-runner: argv carries every isolation flag and runs in the given cwd", async () => {
  const { base, done } = setup();
  try {
    const r = await runWorker({ ...base, env: { FAKE_MODE: "argv" } });
    assert.equal(r.kind, "ok");
    if (r.kind !== "ok") return;
    const seen = JSON.parse(r.text) as { argv: string[]; cwd: string };
    for (const f of ["--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-tools"]) {
      assert.ok(seen.argv.includes(f), `missing ${f}`);
      assert.ok(ISOLATION_FLAGS.includes(f as (typeof ISOLATION_FLAGS)[number]));
    }
    assert.deepEqual(seen.argv.slice(seen.argv.indexOf("--provider"), seen.argv.indexOf("--provider") + 2), ["--provider", "fake"]);
    assert.deepEqual(seen.argv.slice(seen.argv.indexOf("--model"), seen.argv.indexOf("--model") + 2), ["--model", "fake-model"]);
    assert.equal(seen.argv.at(-1), "summarize");
    assert.equal(seen.argv.at(-2), "--");
    assert.equal(seen.cwd, base.cwd);
  } finally {
    done();
  }
});

test("worker-runner: well-formed output is accepted", async () => {
  const { base, done } = setup();
  try {
    assert.deepEqual(await runWorker({ ...base, env: { FAKE_MODE: "ok" } }), { kind: "ok", text: "report ok" });
  } finally {
    done();
  }
});

test("worker-runner: timeout kills the whole process group", async () => {
  const { dir, base, done } = setup();
  const out = join(dir, "grandchild.pid");
  try {
    const r = await runWorker({ ...base, timeoutMs: 500, env: { FAKE_MODE: "hang", FAKE_OUT: out } });
    assert.equal(r.kind, "timeout");
    const gpid = Number(readFileSync(out, "utf8"));
    const deadline = Date.now() + 2_000;
    while (alive(gpid) && Date.now() < deadline) await new Promise((res) => setTimeout(res, 25));
    assert.equal(alive(gpid), false, "grandchild survived timeout");
  } finally {
    done();
  }
});

test("worker-runner: oversized output is rejected and the child is killed", async () => {
  const { base, done } = setup();
  try {
    const started = Date.now();
    const r = await runWorker({ ...base, env: { FAKE_MODE: "big" } });
    assert.deepEqual(r, { kind: "rejected", reason: "oversized" });
    assert.ok(Date.now() - started < base.timeoutMs, "should not wait for timeout");
  } finally {
    done();
  }
});

test("worker-runner: malformed output is rejected", async () => {
  const { base, done } = setup();
  try {
    assert.deepEqual(await runWorker({ ...base, env: { FAKE_MODE: "binary" } }), { kind: "rejected", reason: "malformed" });
    assert.deepEqual(await runWorker({ ...base, env: { FAKE_MODE: "empty" } }), { kind: "rejected", reason: "malformed" });
  } finally {
    done();
  }
});

test("worker-runner: non-zero exit is rejected even with output", async () => {
  const { base, done } = setup();
  try {
    assert.deepEqual(await runWorker({ ...base, env: { FAKE_MODE: "fail" } }), { kind: "rejected", reason: "exit", code: 3 });
  } finally {
    done();
  }
});

test("worker-runner: relative CLI path is refused", async () => {
  const { base, done } = setup();
  try {
    await assert.rejects(runWorker({ ...base, cliPath: "pi" }), /absolute/);
  } finally {
    done();
  }
});
