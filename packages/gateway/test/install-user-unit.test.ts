import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runDoctor } from "../dist/index.js";

const script = fileURLToPath(new URL("../../../scripts/install-user-unit.mjs", import.meta.url));
const workspace = fileURLToPath(new URL("../../../", import.meta.url));

function sandbox() {
  const home = mkdtempSync(join(tmpdir(), "gateway-unit-"));
  const prefix = join(home, "prefix space%$");
  const cli = join(prefix, "dist", "cli.js");
  mkdirSync(join(prefix, "dist"), { recursive: true });
  writeFileSync(cli, "// fixture only\n");
  const bin = join(home, "bin");
  mkdirSync(bin);
  const calls = join(home, "systemctl-calls");
  writeFileSync(join(bin, "systemctl"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$CALLS"\nexit "${SYSTEMCTL_EXIT:-0}"\n', { mode: 0o700 });
  const env = { HOME: home, PATH: bin, CALLS: calls };
  const raw = (args: string[], extraEnv = {}) => spawnSync(process.execPath, [script, ...args], { env: { ...env, ...extraEnv }, encoding: "utf8" });
  const invoke = (args: string[], extraEnv = {}) => raw(["--profile", "pilot", "--prefix", prefix, ...args], extraEnv);
  return { home, prefix, cli, calls, invoke, raw, unit: join(home, ".config", "systemd", "user", "pi-hermes-gateway@pilot.service") };
}

test("install-user-unit defaults to write-free dry-run with concrete absolute paths", () => {
  const s = sandbox();
  try {
    const before = readdirSync(s.home);
    const result = s.invoke([]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\[Service\]/);
    assert.ok(result.stdout.includes(process.execPath));
    assert.ok(result.stdout.includes(s.cli.replaceAll("%", "%%").replaceAll("$", "$$")));
    assert.ok(result.stdout.includes(join(s.home, ".config", "pi-hermes-gateway", "pilot")));
    assert.equal(/%[hi]|TEMPLATE ONLY/.test(result.stdout), false);
    assert.deepEqual(readdirSync(s.home), before);
    assert.equal(existsSync(s.calls), false);
    const repo = s.raw(["--profile", "pilot", "--prefix", workspace]);
    assert.equal(repo.status, 0, repo.stderr);
    assert.ok(repo.stdout.includes(join(workspace, "packages", "gateway", "dist", "cli.js")));
    assert.equal(existsSync(s.calls), false);
  } finally { rmSync(s.home, { recursive: true, force: true }); }
});

test("install-user-unit writes passively; enable alone explicitly reloads and enables only its own unit", () => {
  const s = sandbox();
  try {
    const passive = s.invoke(["--install"]);
    assert.equal(passive.status, 0, passive.stderr);
    assert.equal(readFileSync(s.unit, "utf8"), passive.stdout);
    assert.equal(existsSync(s.calls), false);
    const enabled = s.invoke(["--enable"]);
    assert.equal(enabled.status, 0, enabled.stderr);
    assert.equal(readFileSync(s.calls, "utf8"), "--user daemon-reload\n--user enable pi-hermes-gateway@pilot.service\n");
    const failed = s.invoke(["--enable"], { SYSTEMCTL_EXIT: "7" });
    assert.notEqual(failed.status, 0);
  } finally { rmSync(s.home, { recursive: true, force: true }); }
});

test("install-user-unit refuses a symlink destination without changing its target", () => {
  const s = sandbox();
  try {
    const target = join(s.home, "existing-file");
    const contents = "keep this file unchanged\n";
    writeFileSync(target, contents);
    mkdirSync(join(s.home, ".config", "systemd", "user"), { recursive: true });
    symlinkSync(target, s.unit);
    const result = s.invoke(["--install"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /refusing to write unit to symlink/);
    assert.equal(result.stdout, "");
    assert.equal(readFileSync(target, "utf8"), contents);
    assert.equal(existsSync(s.calls), false);
  } finally { rmSync(s.home, { recursive: true, force: true }); }
});

test("install-user-unit rejects invalid input and Pi-owned prefixes without writes or systemctl", () => {
  const s = sandbox();
  try {
    for (const args of [["--bogus"], ["--profile", "../escape", "--prefix", s.prefix], ["--profile", "pilot", "--prefix"], ["--profile", "pilot", "--prefix", s.prefix, "--install", "--dry-run"], ["--profile", "pilot", "--prefix", s.prefix, "--profile", "other"]]) {
      const result = s.raw(args);
      assert.notEqual(result.status, 0);
      assert.equal(existsSync(s.unit), false);
      assert.equal(existsSync(s.calls), false);
    }
    const pi = join(s.home, ".pi", "agent");
    mkdirSync(pi, { recursive: true });
    symlinkSync(s.prefix, join(pi, "npm"));
    assert.notEqual(s.invoke(["--install"]).status, 0);
    assert.equal(existsSync(s.unit), false);
  } finally { rmSync(s.home, { recursive: true, force: true }); }
});

test("doctor discovers the rendered profile unit and claims logout survival only with linger", () => {
  const s = sandbox();
  try {
    const profileDir = join(s.home, ".config", "pi-hermes-gateway", "pilot");
    mkdirSync(profileDir, { recursive: true, mode: 0o700 });
    chmodSync(profileDir, 0o700);
    const lingerDir = join(s.home, "linger");
    mkdirSync(lingerDir);
    const opts = { profileDir, nodePath: process.execPath, env: { HOME: s.home }, lingerDir, lingerUser: "fixture" };
    assert.equal(runDoctor(opts).unitEvidence, false);
    assert.equal(s.invoke(["--install"]).status, 0);
    const unitOnly = runDoctor(opts);
    assert.equal(unitOnly.unitEvidence, true);
    assert.equal(unitOnly.logoutSurvivalClaim, false);
    writeFileSync(join(lingerDir, "fixture"), "");
    const both = runDoctor(opts);
    assert.equal(both.logoutSurvivalClaim, true);
    assert.ok(both.checks.some((check) => check.id === "unit" && check.ok));
    assert.equal(existsSync(join(profileDir, "gateway.sock")), false);
    assert.equal(existsSync(s.calls), false);
  } finally { rmSync(s.home, { recursive: true, force: true }); }
});
