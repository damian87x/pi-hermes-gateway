import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Copies only git-tracked files, so .git, node_modules, and any stray
// credentials on disk never enter the isolated build directory.
function copyTrackedFiles(src: string, dest: string) {
  const listing = execFileSync("git", ["-C", src, "ls-files", "-z"], { encoding: "utf8" });
  for (const rel of listing.split("\0").filter(Boolean)) {
    const destPath = join(dest, rel);
    mkdirSync(dirname(destPath), { recursive: true });
    cpSync(join(src, rel), destPath);
  }
}

// Re-links node_modules instead of copying it: workspace entries keep their
// original relative symlink so they resolve inside dest, third-party
// packages are symlinked back to src to avoid duplicating installed deps.
function linkNodeModules(src: string, dest: string) {
  const srcNM = join(src, "node_modules");
  const destNM = join(dest, "node_modules");
  mkdirSync(destNM, { recursive: true });
  for (const entry of readdirSync(srcNM)) {
    const srcEntry = join(srcNM, entry);
    const target = lstatSync(srcEntry).isSymbolicLink() ? readlinkSync(srcEntry) : srcEntry;
    symlinkSync(target, join(destNM, entry));
  }
}

const testDir = dirname(fileURLToPath(import.meta.url));
const gatewayDir = dirname(testDir);
const packagesDir = dirname(gatewayDir);
const root = dirname(packagesDir);
const script = join(root, "scripts", "release");

const EXPECTED_TARBALLS = [
  "pi-hermes-gateway-protocol-0.0.0.tgz",
  "pi-hermes-gateway-core-0.0.0.tgz",
  "pi-hermes-gateway-adapter-telegram-0.0.0.tgz",
  "pi-hermes-gateway-adapter-whatsapp-0.0.0.tgz",
  "pi-hermes-gateway-adapter-slack-0.0.0.tgz",
  "pi-hermes-gateway-companion-0.0.0.tgz",
  "pi-hermes-gateway-dashboard-0.0.0.tgz",
  "pi-hermes-gateway-wiki-0.0.0.tgz",
] as const;

test("release script refuses publish and writes tarballs locally", { timeout: 180_000 }, () => {
  assert.equal(existsSync(script), true);
  const src = readFileSync(script, "utf8");
  assert.equal(/\bnpm publish\b/.test(src), false);

  const publishAttempts = [["publish"], ["--publish"], ["npm", "publish"]];
  for (const args of publishAttempts) {
    let failed = false;
    let stderr = "";
    try {
      execFileSync(script, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      failed = true;
      const e = err as { status?: number; stderr?: string };
      stderr = e.stderr ?? "";
      assert.notEqual(e.status, 0);
    }
    assert.equal(failed, true, `expected refuse for ${args.join(" ")}`);
    assert.match(stderr, /refus/i);
    assert.match(stderr, /publish/i);
  }

  const dest = mkdtempSync(join(tmpdir(), "s6-release-"));
  try {
    execFileSync(script, ["--out", dest], {
      cwd: root,
      encoding: "utf8",
      stdio: "pipe",
    });
    const names = readdirSync(dest).filter((n) => n.endsWith(".tgz")).sort();
    assert.deepEqual(names, [...EXPECTED_TARBALLS].sort());
    for (const name of EXPECTED_TARBALLS) {
      assert.equal(existsSync(join(dest, name)), true);
    }
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
});

test("release builds the workspace so packed tarballs contain dist JS even without a prior build", { timeout: 180_000 }, () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "s6-release-src-"));
  const dest = mkdtempSync(join(tmpdir(), "s6-release-out-"));
  try {
    copyTrackedFiles(root, tempRoot);
    linkNodeModules(root, tempRoot);
    for (const ws of ["protocol", "gateway", "adapter-telegram", "adapter-whatsapp", "adapter-slack", "pi-companion", "dashboard", "wiki"]) {
      rmSync(join(tempRoot, "packages", ws, "dist"), { recursive: true, force: true });
    }

    execFileSync(join(tempRoot, "scripts", "release"), ["--out", dest], {
      cwd: tempRoot,
      encoding: "utf8",
      stdio: "pipe",
    });

    for (const name of EXPECTED_TARBALLS) {
      const listing = execFileSync("tar", ["-tzf", join(dest, name)], { encoding: "utf8" });
      assert.match(listing, /^package\/dist\/.*\.js$/m, `${name} missing built dist JS`);
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  }
});
