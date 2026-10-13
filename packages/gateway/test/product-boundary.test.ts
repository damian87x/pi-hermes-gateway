import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { requireApprovedProductBoundary, requireOwnedTaskHome } from "./s6-verify.mjs";

const pathResolver = {
  lstat(path: string) {
    return lstatSync(path);
  },
  realpath: realpathSync,
};

test("requireOwnedTaskHome accepts an owned disposable directory and rejects everything else", () => {
  const home = mkdtempSync(join(tmpdir(), "s6-boundary-"));
  try {
    assert.equal(requireOwnedTaskHome(pathResolver, process.getuid(), home), home);
    assert.throws(() => requireOwnedTaskHome(pathResolver, process.getuid(), undefined), /explicitly supplied owned task home/);
    assert.throws(() => requireOwnedTaskHome(pathResolver, process.getuid(), "relative/path"), /explicitly supplied owned task home/);
    assert.throws(() => requireOwnedTaskHome(pathResolver, process.getuid() + 1, home), /not owned by the task user/);

    const notADir = join(home, "file");
    writeFileSync(notADir, "");
    assert.throws(() => requireOwnedTaskHome(pathResolver, process.getuid(), notADir), /not a directory/);

    const linked = join(home, "linked");
    symlinkSync(home, linked, "dir");
    assert.throws(() => requireOwnedTaskHome(pathResolver, process.getuid(), linked), /symlink/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("requireApprovedProductBoundary allows a well-formed call and fails closed on every denied shape", () => {
  const allowedExecutables = new Map([["/usr/bin/git", "hash"]]);
  const base = {
    allowedExecutables,
    command: "/usr/bin/git",
    args: ["archive", "--format=tar", "HEAD"],
    env: { HOME: "/owned/task/work", npm_config_registry: "http://127.0.0.1:9/" } as Record<string, string>,
    taskHome: "/owned/task",
    realHome: "/home/real-user",
    registry: "http://127.0.0.1:9/",
  };

  assert.doesNotThrow(() => requireApprovedProductBoundary(base));
  assert.doesNotThrow(() => requireApprovedProductBoundary({ ...base, env: undefined }));

  assert.throws(
    () => requireApprovedProductBoundary({ ...base, command: "/usr/bin/systemctl" }),
    /not an approved product executable/,
  );
  assert.throws(
    () => requireApprovedProductBoundary({ ...base, args: ["publish"] }),
    /denied action in subprocess argument/,
  );
  assert.throws(
    () => requireApprovedProductBoundary({ ...base, args: ["x", "systemctl", "enable-linger"] }),
    /denied action in subprocess argument/,
  );
  assert.throws(
    () => requireApprovedProductBoundary({ ...base, env: { ...base.env, TELEGRAM_BOT_TOKEN: "x" } }),
    /credential-shaped key/,
  );
  assert.throws(
    () => requireApprovedProductBoundary({ ...base, env: { ...base.env, HOME: "/outside/task/home" } }),
    /escapes the owned disposable task home/,
  );
  assert.throws(
    () => requireApprovedProductBoundary({ ...base, env: { ...base.env, HOME: base.realHome } }),
    /escapes the owned disposable task home/,
  );
  assert.throws(
    () => requireApprovedProductBoundary({ ...base, env: { ...base.env, npm_config_registry: "https://registry.npmjs.org/" } }),
    /not the isolated offline sink/,
  );
});
