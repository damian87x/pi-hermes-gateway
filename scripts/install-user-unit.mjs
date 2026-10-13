#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

const usage = "usage: node scripts/install-user-unit.mjs --profile NAME --prefix DIR [--dry-run | --install | --enable]";

function parse(args) {
  const opts = new Map();
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!["--profile", "--prefix", "--dry-run", "--install", "--enable"].includes(key) || opts.has(key)) {
      throw new Error(`unknown or duplicate option: ${key}`);
    }
    if (key === "--profile" || key === "--prefix") {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error(`${key} requires a value`);
      opts.set(key, value);
    } else opts.set(key, true);
  }
  const profile = opts.get("--profile");
  if (typeof profile !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(profile)) {
    throw new Error("--profile must be a simple name (1-64 letters, digits, underscores or hyphens)");
  }
  if (!opts.has("--prefix")) throw new Error("--prefix is required");
  if (opts.has("--dry-run") && (opts.has("--install") || opts.has("--enable"))) {
    throw new Error("--dry-run cannot be combined with --install or --enable");
  }
  return opts;
}

function inside(root, path) {
  return path === root || path.startsWith(root + sep);
}

function assertManagedPath(path, home) {
  if (!isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path)) throw new Error("paths must be absolute and contain no control characters");
  const real = realpathSync(path);
  const piPrefix = join(home, ".pi", "agent", "npm");
  if ([path, real].some((p) => p.includes("/.pi/agent/npm/") || p.endsWith("/.pi/agent/npm")) ||
      (existsSync(piPrefix) && inside(realpathSync(piPrefix), real))) {
    throw new Error("Node and CLI paths must not be under the Pi agent npm prefix");
  }
}

// systemd quoting is not shell quoting: percent specifiers and ExecStart environment expansion
// must be escaped even inside double quotes.
function quote(path, exec = false) {
  if (/[\x00-\x1f\x7f]/.test(path)) throw new Error("paths must contain no control characters");
  let escaped = path.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%");
  if (exec) escaped = escaped.replaceAll("$", "$$");
  return `"${escaped}"`;
}

function main() {
  const opts = parse(process.argv.slice(2));
  const home = process.env.HOME ?? homedir();
  if (!isAbsolute(home)) throw new Error("HOME must be absolute");
  const prefix = resolve(opts.get("--prefix"));
  assertManagedPath(prefix, home);
  const candidates = [join(prefix, "packages/gateway/dist/cli.js"), join(prefix, "dist/cli.js"), join(prefix, "lib/node_modules/pi-hermes-gateway-core/dist/cli.js")];
  const cli = candidates.find((path) => existsSync(path) && statSync(path).isFile());
  if (!cli) throw new Error("no built gateway CLI found under --prefix; build or install the gateway first");
  assertManagedPath(cli, home);
  const node = realpathSync(process.execPath);
  assertManagedPath(node, home);
  const profile = opts.get("--profile");
  const profileDir = join(home, ".config", "pi-hermes-gateway", profile);
  const unitName = `pi-hermes-gateway@${profile}.service`;
  const template = readFileSync(new URL("../packages/gateway/systemd/pi-hermes-gateway@.service", import.meta.url), "utf8");
  const unit = template.split("\n").filter((line) => !line.startsWith("#")).map((line) => {
    if (line.startsWith("Description=")) return `Description=pi-hermes-gateway profile ${profile}`;
    if (line.startsWith("ExecStart=")) return `ExecStart=${quote(node, true)} ${quote(cli, true)} --profile ${quote(profileDir, true)}`;
    if (line.startsWith("WorkingDirectory=")) return `WorkingDirectory=${quote(prefix)}`;
    return line;
  }).join("\n").trimStart();
  if (opts.has("--install") || opts.has("--enable")) {
    const unitDir = join(home, ".config", "systemd", "user");
    const destination = join(unitDir, unitName);
    if (lstatSync(destination, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error(`refusing to write unit to symlink: ${destination}`);
    }
    mkdirSync(unitDir, { recursive: true });
    writeFileSync(destination, unit, { mode: 0o644 });
    if (opts.has("--enable")) {
      for (const args of [["--user", "daemon-reload"], ["--user", "enable", unitName]]) {
        const result = spawnSync("systemctl", args, { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" });
        if (result.error || result.status !== 0) throw new Error(`systemctl ${args.join(" ")} failed: ${result.error?.message ?? result.stderr}`);
      }
    }
  }
  process.stdout.write(unit);
}

try { main(); } catch (error) {
  process.stderr.write(`${error.message}\n${usage}\n`);
  process.exitCode = 1;
}
