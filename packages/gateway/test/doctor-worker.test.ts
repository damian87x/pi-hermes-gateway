import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctor } from "../dist/doctor.js";

test("doctor warns for missing configured worker CLI without running it or enabling linger", () => {
  const profileDir = mkdtempSync(join(tmpdir(), "doctor-worker-"));
  chmodSync(profileDir, 0o700);
  const missingCli = join(profileDir, "missing-worker");
  const report = runDoctor({ profileDir, nodePath: process.execPath, cliPath: missingCli, lingerEnabled: false });
  const cliCheck = report.checks.find((check) => check.id === "cli-path");
  assert.equal(cliCheck?.ok, false);
  assert.equal(cliCheck?.severity, "warn");
  assert.equal(report.lingerEnabled, false);
  assert.equal(report.lingerPrecondition, false);
  assert.equal(report.logoutSurvivalClaim, false);
  assert.equal(existsSync(missingCli), false);
});
