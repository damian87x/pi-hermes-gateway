import assert from "node:assert/strict";
import { test } from "node:test";
import { loadWorkerProfile } from "../dist/worker/profiles.js";

test("loadWorkerProfile loads a known profile by id", () => {
  const profile = loadWorkerProfile({ profileId: "report" });
  assert.equal(profile.id, "report");
  assert.equal(typeof profile.executablePath, "string");
});

test("loadWorkerProfile on missing id throws a helpful error and starts nothing", () => {
  assert.throws(
    () => loadWorkerProfile({ profileId: "does-not-exist" }),
    /unknown worker profile id "does-not-exist"/,
  );
});

test("loadWorkerProfile rejects inherited registry names", () => {
  for (const profileId of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
    assert.throws(() => loadWorkerProfile({ profileId }), new RegExp(`unknown worker profile id "${profileId}"`));
  }
});

test("loadWorkerProfile ignores an executablePath supplied in the job body", () => {
  const trusted = loadWorkerProfile({ profileId: "report" });
  const tampered = loadWorkerProfile({
    profileId: "report",
    executablePath: "/tmp/evil",
  } as Parameters<typeof loadWorkerProfile>[0]);
  assert.equal(tampered.executablePath, trusted.executablePath);
  assert.notEqual(tampered.executablePath, "/tmp/evil");
});
