import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runDoctor } from "../dist/doctor.js";
import { cleanup, tmpDir } from "./helpers.ts";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const fakeModule = fileURLToPath(new URL("../dist/fake-adapter.js", import.meta.url));
// A key-presence sentinel, not a token string or a usable adapter configuration.
const tokenPresence = { adapter: { module: fakeModule, config: { token: null } } };

function setup(t: { after(fn: () => void): void }, content?: string, mode = 0o600) {
  const dir = tmpDir();
  chmodSync(dir, 0o700);
  t.after(() => cleanup(dir));
  const path = join(dir, "config.json");
  if (content !== undefined) {
    writeFileSync(path, content, { mode });
    chmodSync(path, mode);
  }
  const doctor = () => runDoctor({ profileDir: dir, lingerEnabled: false });
  return { dir, path, doctor };
}

test("doctor rejects every group/other permission on config.json with an adapter token key", (t) => {
  for (const mode of [0o640, 0o604, 0o620, 0o602, 0o610, 0o601, 0o644]) {
    const { doctor } = setup(t, JSON.stringify(tokenPresence), mode);
    const report = doctor();
    assert.equal(report.ok, false, mode.toString(8));
    assert.deepEqual(report.checks.find((c) => c.id === "config-file"), {
      id: "config-file", ok: false, severity: "error",
      message: "config.json containing an adapter token must be owned by the current user with mode 0600",
    });
    assert.equal(report.logoutSurvivalClaim, false);
  }
});

test("doctor allows private token-key sentinel, tokenless fake config, and absent config", (t) => {
  for (const [content, mode] of [
    [JSON.stringify(tokenPresence), 0o600],
    [JSON.stringify({ adapter: { module: fakeModule, config: { sinkPath: "unused-fake-sink" } } }), 0o644],
    [undefined, 0o600],
  ] as const) {
    const { doctor } = setup(t, content, mode);
    const report = doctor();
    assert.equal(report.ok, true);
    assert.equal(report.checks.find((c) => c.id === "config-file")?.ok, true);
  }
});

test("doctor reports malformed config generically without echoing file contents", (t) => {
  const content = '{"adapter":{"config":{"token":null}},"malformed-marker":';
  const { doctor } = setup(t, content);
  const report = doctor();
  assert.equal(report.ok, false);
  assert.equal(report.checks.find((c) => c.id === "config-file")?.message, "config.json must contain valid JSON");
  assert.equal(JSON.stringify(report).includes("malformed-marker"), false);
});

test("doctor refuses a config symlink without following it", (t) => {
  const { dir, path, doctor } = setup(t);
  const target = join(dir, "sentinel.json");
  writeFileSync(target, JSON.stringify(tokenPresence), { mode: 0o600 });
  symlinkSync(target, path);
  const report = doctor();
  assert.equal(report.ok, false);
  assert.equal(report.checks.find((c) => c.id === "config-file")?.message, "config.json must be a regular file, not a symlink");
});

test("doctor rejects a WhatsApp auth path that aliases another directory", (t) => {
  const { dir, doctor } = setup(t);
  const external = tmpDir();
  chmodSync(external, 0o700);
  t.after(() => cleanup(external));
  assert.equal(doctor().checks.find((c) => c.id === "whatsapp-auth")?.ok, true);
  symlinkSync(external, join(dir, "whatsapp-auth"));
  const report = doctor();
  assert.equal(report.ok, false);
  assert.deepEqual(report.checks.find((c) => c.id === "whatsapp-auth"), {
    id: "whatsapp-auth", ok: false, severity: "error",
    message: "WhatsApp auth path must be a real directory under the profile; symlinks are not allowed",
  });
});

test("doctor rejects a symlinked WhatsApp profile directory", (t) => {
  const profile = tmpDir();
  const existing = tmpDir();
  chmodSync(profile, 0o700);
  chmodSync(existing, 0o700);
  t.after(() => cleanup(profile));
  t.after(() => cleanup(existing));
  const secretSentinel = "profile-alias-session-secret-sentinel-not-real";
  writeFileSync(join(existing, "config.json"), JSON.stringify({ adapter: { config: { sessionSecret: secretSentinel } } }), { mode: 0o600 });
  const link = join(profile, "whatsapp-pilot");
  symlinkSync(existing, link);
  const report = runDoctor({ profileDir: link, lingerEnabled: false });
  assert.equal(report.ok, false);
  assert.deepEqual(report.checks.find((c) => c.id === "whatsapp-auth"), {
    id: "whatsapp-auth", ok: false, severity: "error", message: "WhatsApp profile must be a real directory",
  });
  assert.deepEqual(report.checks.find((c) => c.id === "config-file"), {
    id: "config-file", ok: false, severity: "error", message: "config.json profile path must be a real directory",
  });
  assert.equal(JSON.stringify(report).includes(secretSentinel), false);
});

test("doctor rejects symlinked WhatsApp profile paths with trailing separators and dot segments", (t) => {
  for (const suffix of ["/", "/."]) {
    const { dir } = setup(t);
    const existing = tmpDir();
    chmodSync(existing, 0o700);
    t.after(() => cleanup(existing));
    symlinkSync(existing, join(dir, "whatsapp-pilot"));
    const report = runDoctor({ profileDir: `${join(dir, "whatsapp-pilot")}${suffix}`, lingerEnabled: false });
    assert.equal(report.ok, false, suffix);
    assert.deepEqual(report.checks.find((c) => c.id === "whatsapp-auth"), {
      id: "whatsapp-auth", ok: false, severity: "error", message: "WhatsApp profile must be a real directory",
    }, suffix);
    assert.deepEqual(report.checks.find((c) => c.id === "config-file"), {
      id: "config-file", ok: false, severity: "error", message: "config.json profile path must be a real directory",
    }, suffix);
  }
});

test("CLI doctor never echoes a WhatsApp session-secret sentinel", (t) => {
  const secretSentinel = "whatsapp-session-secret-sentinel-not-real";
  const { dir } = setup(t, JSON.stringify({
    adapter: { module: fakeModule, config: { kind: "send-only", sessionSecret: secretSentinel } },
  }));
  const external = tmpDir();
  chmodSync(external, 0o700);
  t.after(() => cleanup(external));
  symlinkSync(external, join(dir, "whatsapp-auth"));
  const result = spawnSync(process.execPath, [cli, "--profile", dir, "doctor"], { encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout.includes(secretSentinel), false);
  assert.equal(result.stderr.includes(secretSentinel), false);
  const report = JSON.parse(result.stdout);
  assert.equal(report.checks.find((c: { id: string }) => c.id === "whatsapp-auth").severity, "error");
  assert.deepEqual(readdirSync(dir).sort(), ["config.json", "whatsapp-auth"]);
});

test("CLI doctor exits 1 for unsafe config without loading any adapter or mutating profile", (t) => {
  const { dir, path } = setup(t, JSON.stringify(tokenPresence), 0o644);
  const before = readFileSync(path, "utf8");
  const result = spawnSync(process.execPath, [cli, "--profile", dir, "doctor"], { encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.checks.find((c: { id: string }) => c.id === "config-file").severity, "error");
  assert.equal(result.stdout.includes(fakeModule), false, "adapter configuration is not echoed");
  assert.equal(result.stdout.includes('"token"'), false);
  assert.equal(readFileSync(path, "utf8"), before);
  assert.deepEqual(readdirSync(dir), ["config.json"], "doctor creates no ledger, socket, sink, or lock");
});
