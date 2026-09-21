#!/usr/bin/env bash
set -euo pipefail
ROOT="/home/damian-linux/workspace/billioner-coder/apps/pi-hermes-gateway-s1-review"
cd "$ROOT"
echo "ROOT=$ROOT"
echo "HEAD=$(git rev-parse HEAD)"
echo "BASE=$(git rev-parse 83341eb)"
echo "BRANCH=$(git rev-parse --abbrev-ref HEAD)"
test "$(git rev-parse HEAD)" = "f5c88a4323bdf8d3a2e1f30aee7eb8dd63195678"
case "$ROOT" in
  */apps/pi-hermes-gateway-s1-review) ;;
  *) echo "not the isolated s1 worktree"; exit 1 ;;
esac
test -d packages/gateway
test ! -d packages/adapter-telegram
test ! -d packages/adapter-whatsapp
test ! -d packages/pi-companion
test ! -d packages/telegram-companion
python3 - <<'PY'
import json, pathlib, subprocess, sys
root = pathlib.Path(".")
allowed_prefixes = (
    "packages/gateway/",
    "docs/evidence/s1/",
)
allowed_exact = {
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    ".gitignore",
    "README.md",
    "docs/architecture.md",
    "docs/security.md",
    "docs/parity.md",
    "docs/migration.md",
    "docs/provenance.md",
}
diff = subprocess.check_output(["git", "diff", "--name-only", "83341eb"], text=True)
untracked = subprocess.check_output(["git", "ls-files", "--others", "--exclude-standard"], text=True)
paths = [p for p in (diff + untracked).splitlines() if p]
bad_paths = []
for p in paths:
    if p in allowed_exact:
        continue
    if any(p.startswith(pref) for pref in allowed_prefixes):
        continue
    bad_paths.append(p)
if bad_paths:
    print("paths outside S1 allowlist:")
    print("\n".join(bad_paths))
    sys.exit(1)
forbidden_scripts = {
    "preinstall","install","postinstall","prepare","preprepare","postprepare",
    "prepublish","prepublishOnly","publish","postpublish","prepack","postpack",
}
bad = []
pkgs = [root / "package.json", *root.glob("packages/*/package.json")]
priv = 0
for p in pkgs:
    data = json.loads(p.read_text())
    if data.get("private") is True:
        priv += 1
    else:
        bad.append(f"{p}: private is not true")
    if "license" in data:
        bad.append(f"{p}: license field present")
    if "pi" in data:
        bad.append(f"{p}: pi manifest present")
    scripts = data.get("scripts") or {}
    for name in scripts:
        if name in forbidden_scripts:
            bad.append(f"{p}: lifecycle script {name}")
    if data.get("peerDependencies"):
        bad.append(f"{p}: peerDependencies")
if len(pkgs) != 3:
    bad.append(f"expected 3 package.json files, found {len(pkgs)}")
if bad:
    print("\n".join(bad))
    sys.exit(1)
print("private/lifecycle/pi checks ok", [str(p) for p in pkgs], "privateTrue", priv)
print("changed_or_untracked", len(paths))
PY
echo G1_OK
