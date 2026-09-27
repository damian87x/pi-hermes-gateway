import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createFakeAdapter, probeLingerEnabled, runDoctor, startDaemon, TestClock, type SendAdapter } from "../dist/index.js";
import { cleanup, collectUnhandledRejections, deferred, flushAsync, handle, ROUTE, tmpDir } from "./helpers.ts";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const doctorSrcPath = fileURLToPath(new URL("../src/doctor.ts", import.meta.url));
const cliSrcPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const unitPath = fileURLToPath(new URL("../systemd/pi-hermes-gateway@.service", import.meta.url));

test("doctor checks absolute Node, node:sqlite, profile dirs; missing linger warns and refuses logout-survival", () => {
  const dir = tmpDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const report = runDoctor({ profileDir: dir, nodePath: process.execPath, lingerEnabled: false });
  assert.equal(report.ok, true);
  assert.equal(report.lingerEnabled, false);
  assert.equal(report.logoutSurvivalClaim, false);
  assert.ok(report.checks.some((c) => c.id === "node-path" && c.ok === true && c.severity === "info"));
  assert.ok(report.checks.some((c) => c.id === "node-sqlite" && c.ok === true));
  assert.ok(report.checks.some((c) => c.id === "profile-dirs" && c.ok === true));
  const linger = report.checks.find((c) => c.id === "linger");
  assert.ok(linger);
  assert.equal(linger.ok, true);
  assert.equal(linger.severity, "warn");
  assert.match(linger.message, /linger/i);
  assert.match(linger.message, /logout-survival|logout survival/i);
  cleanup(dir);
});

test("doctor rejects relative Node path and ~/.pi/agent/npm prefix", () => {
  const dir = tmpDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const rel = runDoctor({ profileDir: dir, nodePath: "node", lingerEnabled: true });
  assert.equal(rel.ok, false);
  assert.equal(rel.logoutSurvivalClaim, false);
  assert.ok(rel.checks.some((c) => c.id === "node-path" && c.ok === false && c.severity === "error"));
  const banned = runDoctor({
    profileDir: dir,
    nodePath: join("/home/x", ".pi/agent/npm/bin/node"),
    lingerEnabled: true,
  });
  assert.equal(banned.ok, false);
  assert.equal(banned.logoutSurvivalClaim, false);
  assert.ok(banned.checks.some((c) => c.id === "node-path" && c.ok === false));
  cleanup(dir);
});

test("doctor does not enable linger; systemd template is install-inert and avoids pi agent npm", () => {
  const doctorSrc = readFileSync(doctorSrcPath, "utf8");
  const cliSrc = readFileSync(cliSrcPath, "utf8");
  const unit = readFileSync(unitPath, "utf8");
  for (const src of [doctorSrc, cliSrc, unit]) {
    assert.equal(src.includes("enable-linger"), false);
    assert.equal(/systemctl\s+enable/.test(src), false);
  }
  assert.equal(unit.includes(".pi/agent/npm"), false);
  assert.match(unit, /\[Unit\]/);
  assert.match(unit, /\[Service\]/);
  assert.match(unit, /ExecStart=/);
  assert.match(unit, /\/usr\/bin\/node/);
  assert.match(unit, /TEMPLATE/);
  assert.match(unit, /StartLimitBurst=/);
  assert.match(unit, /StartLimitIntervalSec=/);
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as {
    files: string[];
  };
  assert.ok(pkg.files.includes("systemd"));
});

test("restart still delivers once-at to fake sink; second daemon fails", () => {
  const dir = tmpDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  writeFileSync(join(dir, "config.json"), JSON.stringify({ routes: [ROUTE] }), { mode: 0o600 });
  const sink = join(dir, "fake-sink.json");
  const t0 = Date.UTC(2026, 0, 1, 10, 0, 0);
  const at = "2026-01-01T12:00:00.000Z";
  const clock1 = new TestClock(t0);
  const adapter1 = createFakeAdapter({ sinkPath: sink });
  const d1 = startDaemon({
    profileDir: dir,
    routes: [ROUTE],
    clock: clock1,
    adapter: adapter1,
    bindSocket: true,
    tickIntervalMs: 60_000,
  });
  const created = handle(
    d1.gateway,
    "job.create",
    {
      kind: "static-text",
      text: "restart-once",
      route: ROUTE,
      schedule: { type: "once", atUtc: at },
    },
    clock1.nowMs(),
  );
  assert.equal(created.ok, true);
  d1.gateway.tick();
  assert.equal(adapter1.sent.length, 0);
  assert.equal(existsSync(sink), false);
  d1.stop();

  const clock2 = new TestClock(Date.parse(at));
  const adapter2 = createFakeAdapter({ sinkPath: sink });
  const d2 = startDaemon({
    profileDir: dir,
    routes: [ROUTE],
    clock: clock2,
    adapter: adapter2,
    bindSocket: true,
    tickIntervalMs: 60_000,
  });
  assert.equal(adapter2.sent.length, 1);
  assert.equal(adapter2.sent[0]?.text, "restart-once");
  assert.equal(existsSync(sink), true);
  assert.match(readFileSync(sink, "utf8"), /restart-once/);
  assert.throws(() => {
    startDaemon({ profileDir: dir, routes: [ROUTE], clock: clock2, bindSocket: true });
  }, /profile lock held/);
  assert.equal(existsSync(join(dir, "gateway.sock")), true);
  d2.stop();

  const clock3 = new TestClock(Date.parse(at) + 1_000);
  const adapter3 = createFakeAdapter({ sinkPath: sink });
  const d3 = startDaemon({
    profileDir: dir,
    routes: [ROUTE],
    clock: clock3,
    adapter: adapter3,
    bindSocket: true,
    tickIntervalMs: 60_000,
  });
  assert.equal(adapter3.sent.length, 0);
  assert.equal(adapter2.sent.length, 1);
  const sinkText = readFileSync(sink, "utf8");
  assert.equal(sinkText.match(/restart-once/g)?.length, 1);
  d3.stop();
  cleanup(dir);
});

test("stop during a deferred async send: no closed-store write, restart records commit-unknown without replay", async () => {
  const dir = tmpDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const clock = new TestClock(Date.UTC(2026, 0, 1, 10, 0, 0));
  const receipt = deferred<{ receiptLevel: "accepted"; providerMessageId: string }>();
  let sends = 0;
  const asyncAdapter: SendAdapter = {
    manifest: createFakeAdapter().manifest,
    send() {
      sends += 1;
      return receipt.promise;
    },
  };
  const unhandled = await collectUnhandledRejections(async () => {
    const d1 = startDaemon({ profileDir: dir, routes: [ROUTE], clock, adapter: asyncAdapter, bindSocket: false });
    let deliveryId: string;
    try {
      const res = handle(d1.gateway, "delivery.enqueue", { route: ROUTE, text: "deferred", notAfter: clock.nowMs() + 60_000 }, clock.nowMs());
      assert.equal(res.ok, true);
      const body = (res as { body: { deliveryId: string; status: string } }).body;
      deliveryId = body.deliveryId;
      assert.equal(body.status, "dispatching");
    } finally {
      d1.stop();
    }
    receipt.resolve({ receiptLevel: "accepted", providerMessageId: "late" });
    await flushAsync();

    const adapter2 = createFakeAdapter();
    const d2 = startDaemon({ profileDir: dir, routes: [ROUTE], clock, adapter: adapter2, bindSocket: false });
    try {
      assert.equal(d2.gateway.store.getDelivery(deliveryId)?.status, "commit-unknown");
      assert.ok(d2.gateway.store.listAudit().some((a) => a.kind === "crash.recover"));
      assert.equal(d2.gateway.store.listAudit().some((a) => a.kind === "delivery.accepted"), false);
      d2.gateway.tick();
      assert.equal(adapter2.sent.length, 0);
    } finally {
      d2.stop();
    }
  });
  assert.deepEqual(unhandled, []);
  assert.equal(sends, 1);
  cleanup(dir);
});

const OUTBOX_HALT_DIAGNOSTIC =
  "gateway outbox halted: dispatch persistence failed; no further sends until restart; remaining dispatching deliveries become commit-unknown on restart\n";

test("async accepted receipt that cannot be written halts the daemon outbox with one stderr diagnostic even if its audit fails; restart recovers commit-unknown and sends the queued row once", async () => {
  const dir = tmpDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const clock = new TestClock(Date.UTC(2026, 0, 1, 10, 0, 0));
  const receipt = deferred<{ receiptLevel: "accepted"; providerMessageId: string }>();
  const asyncSent: string[] = [];
  const asyncAdapter: SendAdapter = {
    manifest: createFakeAdapter().manifest,
    send(envelope) {
      asyncSent.push(envelope.deliveryId);
      return receipt.promise;
    },
  };
  let first = "";
  let second = "";
  const unhandled = await collectUnhandledRejections(async () => {
    const d1 = startDaemon({ profileDir: dir, routes: [ROUTE], clock, adapter: asyncAdapter, bindSocket: false });
    const side = new DatabaseSync(join(dir, "gateway.sqlite"));
    try {
      const enqueue = (text: string) => {
        const res = handle(d1.gateway, "delivery.enqueue", { route: ROUTE, text, notAfter: clock.nowMs() + 60_000 }, clock.nowMs());
        return (res as { body: { deliveryId: string } }).body.deliveryId;
      };
      first = enqueue("first");
      second = enqueue("second");
      side.exec(
        "CREATE TRIGGER block_accepted BEFORE UPDATE OF status ON deliveries WHEN NEW.status = 'accepted' " +
          "BEGIN SELECT RAISE(ABORT, 'injected accepted write failure'); END",
      );
      side.exec(
        "CREATE TRIGGER block_halt_audit BEFORE INSERT ON audit WHEN NEW.kind = 'outbox.halted' " +
          "BEGIN SELECT RAISE(ABORT, 'injected audit write failure'); END",
      );
      const stderrWrites: string[] = [];
      const realStderrWrite = process.stderr.write;
      process.stderr.write = ((chunk: string | Uint8Array) => {
        stderrWrites.push(String(chunk));
        return true;
      }) as typeof process.stderr.write;
      try {
        receipt.resolve({ receiptLevel: "accepted", providerMessageId: "p:first" });
        await flushAsync();
        assert.ok(d1.gateway.outboxHalt);
        side.exec("DROP TRIGGER block_accepted");
        side.exec("DROP TRIGGER block_halt_audit");
        d1.gateway.tick();
        const fresh = handle(d1.gateway, "delivery.enqueue", { route: ROUTE, text: "fresh", notAfter: clock.nowMs() + 60_000 }, clock.nowMs());
        assert.equal(fresh.ok, false);
        assert.equal((fresh as { error: { code: string } }).error.code, "outbox_halted");
        await flushAsync();
      } finally {
        process.stderr.write = realStderrWrite;
      }
      assert.deepEqual(stderrWrites, [OUTBOX_HALT_DIAGNOSTIC]);
      assert.equal(d1.gateway.store.listAudit().some((a) => a.kind === "outbox.halted"), false);
      assert.deepEqual(asyncSent, [first]);
      assert.equal(d1.gateway.store.getDelivery(first)?.status, "dispatching");
      assert.equal(d1.gateway.store.getDelivery(second)?.status, "queued");
    } finally {
      side.close();
      d1.stop();
    }

    const adapter2 = createFakeAdapter();
    const d2 = startDaemon({ profileDir: dir, routes: [ROUTE], clock, adapter: adapter2, bindSocket: false });
    try {
      assert.equal(d2.gateway.outboxHalt, null);
      assert.equal(d2.gateway.store.getDelivery(first)?.status, "commit-unknown");
      assert.equal(d2.gateway.store.getDelivery(second)?.status, "accepted");
      d2.gateway.tick();
      assert.deepEqual(
        adapter2.sent.map((e) => e.deliveryId),
        [second],
      );
    } finally {
      d2.stop();
    }
  });
  assert.deepEqual(unhandled, []);
  assert.deepEqual(asyncSent, [first]);
  cleanup(dir);
});

test("synchronous accepted receipt that cannot be written halts the daemon outbox with one stderr diagnostic; restart recovers commit-unknown without replay", async () => {
  const dir = tmpDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const clock = new TestClock(Date.UTC(2026, 0, 1, 10, 0, 0));
  const syncSent: string[] = [];
  const syncAdapter: SendAdapter = {
    manifest: createFakeAdapter().manifest,
    send(envelope) {
      syncSent.push(envelope.deliveryId);
      return { receiptLevel: "accepted", providerMessageId: `p:${envelope.deliveryId}` };
    },
  };
  let first = "";
  const unhandled = await collectUnhandledRejections(async () => {
    const d1 = startDaemon({ profileDir: dir, routes: [ROUTE], clock, adapter: syncAdapter, bindSocket: false });
    const side = new DatabaseSync(join(dir, "gateway.sqlite"));
    try {
      side.exec(
        "CREATE TRIGGER block_accepted BEFORE UPDATE OF status ON deliveries WHEN NEW.status = 'accepted' " +
          "BEGIN SELECT RAISE(ABORT, 'injected accepted write failure'); END",
      );
      const stderrWrites: string[] = [];
      const realStderrWrite = process.stderr.write;
      process.stderr.write = ((chunk: string | Uint8Array) => {
        stderrWrites.push(String(chunk));
        return true;
      }) as typeof process.stderr.write;
      try {
        const res = handle(d1.gateway, "delivery.enqueue", { route: ROUTE, text: "first", notAfter: clock.nowMs() + 60_000 }, clock.nowMs());
        assert.equal(res.ok, true);
        const body = (res as { body: { deliveryId: string; status: string } }).body;
        first = body.deliveryId;
        assert.equal(body.status, "dispatching");
        assert.ok(d1.gateway.outboxHalt);
        side.exec("DROP TRIGGER block_accepted");
        d1.gateway.tick();
        const fresh = handle(d1.gateway, "delivery.enqueue", { route: ROUTE, text: "fresh", notAfter: clock.nowMs() + 60_000 }, clock.nowMs());
        assert.equal(fresh.ok, false);
        assert.equal((fresh as { error: { code: string } }).error.code, "outbox_halted");
        await flushAsync();
      } finally {
        process.stderr.write = realStderrWrite;
      }
      assert.deepEqual(stderrWrites, [OUTBOX_HALT_DIAGNOSTIC]);
      assert.ok(d1.gateway.store.listAudit().some((a) => a.kind === "outbox.halted"));
      assert.deepEqual(syncSent, [first]);
      assert.equal(d1.gateway.store.getDelivery(first)?.status, "dispatching");
    } finally {
      side.close();
      d1.stop();
    }

    const d2 = startDaemon({ profileDir: dir, routes: [ROUTE], clock, adapter: syncAdapter, bindSocket: false });
    try {
      assert.equal(d2.gateway.outboxHalt, null);
      assert.equal(d2.gateway.store.getDelivery(first)?.status, "commit-unknown");
      assert.ok(d2.gateway.store.listAudit().some((a) => a.kind === "crash.recover"));
      d2.gateway.tick();
    } finally {
      d2.stop();
    }
  });
  assert.deepEqual(unhandled, []);
  assert.deepEqual(syncSent, [first]);
  cleanup(dir);
});

test("stop does not wait on a hung async send", async () => {
  const dir = tmpDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const clock = new TestClock(Date.UTC(2026, 0, 1, 10, 0, 0));
  const hungAdapter: SendAdapter = {
    manifest: createFakeAdapter().manifest,
    send() {
      return new Promise(() => {});
    },
  };
  const d1 = startDaemon({ profileDir: dir, routes: [ROUTE], clock, adapter: hungAdapter, bindSocket: false });
  let deliveryId: string;
  try {
    const res = handle(d1.gateway, "delivery.enqueue", { route: ROUTE, text: "hung", notAfter: clock.nowMs() + 60_000 }, clock.nowMs());
    deliveryId = (res as { body: { deliveryId: string } }).body.deliveryId;
    assert.equal(d1.gateway.store.getDelivery(deliveryId)?.status, "dispatching");
  } finally {
    d1.stop();
  }
  const d2 = startDaemon({ profileDir: dir, routes: [ROUTE], clock, bindSocket: false });
  try {
    assert.equal(d2.gateway.store.getDelivery(deliveryId)?.status, "commit-unknown");
  } finally {
    d2.stop();
  }
  cleanup(dir);
});

test("doctor CLI prints report and does not start a daemon", async () => {
  const dir = tmpDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const child = spawn(process.execPath, [cliPath, "--profile", dir, "doctor"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  child.stdout?.on("data", (c: Uint8Array | string) => {
    stdoutChunks.push(String(c));
  });
  child.stderr?.on("data", (c: Uint8Array | string) => {
    stderrChunks.push(String(c));
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("doctor CLI timeout")), 8000);
    child.once("exit", (c) => {
      clearTimeout(t);
      resolve(c);
    });
    child.once("error", reject);
  });
  const stdout = stdoutChunks.join("");
  const stderr = stderrChunks.join("");
  assert.equal(code, 0);
  assert.equal(stderr.includes("gateway listening"), false);
  assert.equal(existsSync(join(dir, "gateway.sock")), false);
  assert.equal(existsSync(join(dir, "gateway.sqlite")), false);
  const report = JSON.parse(stdout) as {
    ok: boolean;
    logoutSurvivalClaim: boolean;
    lingerEnabled: boolean;
    lingerPrecondition: boolean;
    unitEvidence: boolean;
  };
  assert.equal(report.ok, true);
  assert.equal(report.lingerPrecondition, report.lingerEnabled);
  if (!report.lingerEnabled || !report.unitEvidence) {
    assert.equal(report.logoutSurvivalClaim, false);
  } else {
    assert.equal(report.logoutSurvivalClaim, true);
  }
  if (!report.lingerEnabled) {
    assert.match(stderr, /linger/i);
  }
  cleanup(dir);
});

test("logoutSurvivalClaim requires linger and unit evidence", () => {
  const dir = tmpDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const lingerOnly = runDoctor({ profileDir: dir, nodePath: process.execPath, lingerEnabled: true });
  assert.equal(lingerOnly.ok, true);
  assert.equal(lingerOnly.lingerEnabled, true);
  assert.equal(lingerOnly.lingerPrecondition, true);
  assert.equal(lingerOnly.unitEvidence, false);
  assert.equal(lingerOnly.logoutSurvivalClaim, false);
  const both = runDoctor({
    profileDir: dir,
    nodePath: process.execPath,
    lingerEnabled: true,
    unitEvidence: true,
  });
  assert.equal(both.ok, true);
  assert.equal(both.unitEvidence, true);
  assert.equal(both.logoutSurvivalClaim, true);
  const unitFile = join(dir, "pi-hermes-gateway@.service");
  writeFileSync(unitFile, "# TEMPLATE ONLY\n");
  const viaFile = runDoctor({
    profileDir: dir,
    nodePath: process.execPath,
    lingerEnabled: true,
    unitFile,
  });
  assert.equal(viaFile.unitEvidence, true);
  assert.equal(viaFile.logoutSurvivalClaim, true);
  cleanup(dir);
});

test("doctor profile path check resolves relative ./profile dirs", () => {
  const dir = tmpDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const rel = `./${relative(process.cwd(), dir)}`;
  const report = runDoctor({ profileDir: rel, nodePath: process.execPath, lingerEnabled: false });
  assert.equal(report.ok, true);
  assert.ok(report.checks.some((c) => c.id === "profile-dirs" && c.ok === true));
  cleanup(dir);
});

test("doctor rejects CLI realpath under ~/.pi/agent/npm", () => {
  const dir = tmpDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const banned = runDoctor({
    profileDir: dir,
    nodePath: process.execPath,
    cliPath: "/home/x/.pi/agent/npm/lib/node_modules/pi-hermes-gateway-core/dist/cli.js",
    lingerEnabled: true,
    unitEvidence: true,
  });
  assert.equal(banned.ok, false);
  assert.equal(banned.logoutSurvivalClaim, false);
  assert.ok(banned.checks.some((c) => (c.id === "cli-path" || c.id === "node-path") && c.ok === false));
  cleanup(dir);
});

test("doctor rejects CLI whose realpath is under a symlinked Pi agent npm prefix", () => {
  const dir = tmpDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const home = tmpDir();
  const realPrefix = tmpDir();
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  symlinkSync(realPrefix, join(home, ".pi", "agent", "npm"));
  const cli = join(realPrefix, "cli.js");
  writeFileSync(cli, "");
  const sibling = tmpDir();
  const outsideCli = join(sibling, "cli.js");
  writeFileSync(outsideCli, "");
  const banned = runDoctor({
    profileDir: dir,
    nodePath: process.execPath,
    cliPath: cli,
    lingerEnabled: true,
    unitEvidence: true,
    env: { HOME: home },
  });
  assert.equal(banned.ok, false);
  assert.ok(banned.checks.some((c) => c.id === "cli-path" && c.ok === false));
  const allowed = runDoctor({
    profileDir: dir,
    nodePath: process.execPath,
    cliPath: outsideCli,
    lingerEnabled: true,
    unitEvidence: true,
    env: { HOME: home },
  });
  assert.equal(allowed.ok, true);
  assert.ok(allowed.checks.some((c) => c.id === "cli-path" && c.ok === true));
  cleanup(sibling);
  cleanup(realPrefix);
  cleanup(home);
  cleanup(dir);
});

test("linger probe uses os username and rejects slash in the name", () => {
  const lingerDir = tmpDir();
  mkdirSync(lingerDir, { recursive: true });
  assert.equal(probeLingerEnabled({ user: "../../../../etc", lingerDir }), false);
  assert.equal(probeLingerEnabled({ user: "foo/bar", lingerDir }), false);
  assert.equal(probeLingerEnabled({ user: "", lingerDir }), false);
  assert.equal(probeLingerEnabled({ user: ".", lingerDir }), false);
  assert.equal(probeLingerEnabled({ user: "..", lingerDir }), false);
  const user = userInfo().username;
  assert.equal(user.includes("/"), false);
  writeFileSync(join(lingerDir, user), "");
  assert.equal(probeLingerEnabled({ lingerDir, env: { USER: "nope", LOGNAME: "nope" } }), true);
  cleanup(lingerDir);
});

test("lingerUser '.' and '..' cannot produce a logout-survival claim", () => {
  const dir = tmpDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const lingerDir = tmpDir();
  mkdirSync(lingerDir, { recursive: true });
  for (const lingerUser of ["", ".", ".."]) {
    const report = runDoctor({
      profileDir: dir,
      nodePath: process.execPath,
      lingerUser,
      lingerDir,
      unitEvidence: true,
    });
    assert.equal(report.lingerEnabled, false, lingerUser);
    assert.equal(report.logoutSurvivalClaim, false, lingerUser);
  }
  cleanup(lingerDir);
  cleanup(dir);
});
