import assert from "node:assert/strict";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

const EXPECTED_WORKSPACES = new Map([
  ["packages/protocol", "pi-hermes-gateway-protocol"],
  ["packages/gateway", "pi-hermes-gateway-core"],
  ["packages/adapter-telegram", "pi-hermes-gateway-adapter-telegram"],
  ["packages/adapter-whatsapp", "pi-hermes-gateway-adapter-whatsapp"],
  ["packages/adapter-slack", "pi-hermes-gateway-adapter-slack"],
  ["packages/pi-companion", "pi-hermes-gateway-companion"],
  ["packages/dashboard", "pi-hermes-gateway-dashboard"],
  ["packages/wiki", "pi-hermes-gateway-wiki"],
]);

export function isolatedEnvironment(owned, _untrusted = {}) {
  for (const key of ["home", "tmp", "config", "cache", "npmUserConfig", "npmGlobalConfig"]) {
    if (typeof owned[key] !== "string" || !isAbsolute(owned[key])) throw new Error(`invalid owned ${key}`);
  }
  return {
    PATH: "/usr/bin:/bin",
    HOME: owned.home,
    TMPDIR: owned.tmp,
    TMP: owned.tmp,
    TEMP: owned.tmp,
    XDG_CONFIG_HOME: owned.config,
    XDG_CACHE_HOME: owned.cache,
    npm_config_cache: join(owned.cache, "npm"),
    npm_config_prefix: join(owned.home, "npm-prefix"),
    npm_config_userconfig: owned.npmUserConfig,
    npm_config_globalconfig: owned.npmGlobalConfig,
    npm_config_registry: "http://127.0.0.1:9/",
    npm_config_offline: "true",
    npm_config_ignore_scripts: "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
  };
}

export function workspaceStageMap(root, entries) {
  const names = new Set();
  const paths = new Set();
  const result = [];
  for (const entry of entries) {
    const expectedName = EXPECTED_WORKSPACES.get(entry.dir);
    if (!expectedName || entry.name !== expectedName || names.has(entry.name)) throw new Error("untrusted workspace name");
    const rel = normalize(entry.dir);
    if (isAbsolute(entry.dir) || rel !== entry.dir || rel === "." || rel === ".." || rel.startsWith(`..${sep}`)) {
      throw new Error("untrusted workspace path");
    }
    const source = resolve(root, rel);
    const fromRoot = relative(resolve(root), source);
    if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot) || paths.has(fromRoot)) {
      throw new Error("duplicate or escaping workspace path");
    }
    names.add(entry.name);
    paths.add(fromRoot);
    result.push({ name: entry.name, source, link: join(root, "node_modules", entry.name) });
  }
  return result;
}

export function runSelfTest() {
  const env = isolatedEnvironment({
    home: "/owned/home", tmp: "/owned/tmp", config: "/owned/config", cache: "/owned/cache",
    npmUserConfig: "/owned/home/.npmrc", npmGlobalConfig: "/owned/home/npmrc-global",
  });
  const synthetic = { ...env, SYNTHETIC_TOKEN: "secret", API_KEY: "secret", NODE_OPTIONS: "--import=evil", npm_config_userconfig: "/untrusted/npmrc" };
  const clean = isolatedEnvironment({
    home: "/owned/home", tmp: "/owned/tmp", config: "/owned/config", cache: "/owned/cache",
    npmUserConfig: "/owned/home/.npmrc", npmGlobalConfig: "/owned/home/npmrc-global",
  }, synthetic);
  assert.equal(clean.SYNTHETIC_TOKEN, undefined);
  assert.equal(clean.API_KEY, undefined);
  assert.equal(clean.NODE_OPTIONS, undefined);
  assert.equal(clean.npm_config_userconfig, "/owned/home/.npmrc");
  assert.equal(clean.npm_config_cache, "/owned/cache/npm");
  assert.equal(clean.TMPDIR, "/owned/tmp");
  assert.equal(clean.XDG_CONFIG_HOME, "/owned/config");
  assert.equal(clean.PATH, "/usr/bin:/bin");
  assert.equal(synthetic.NODE_OPTIONS, "--import=evil");
  assert.equal(clean.HOME, "/owned/home");

  const entries = [
    { dir: "packages/protocol", name: "pi-hermes-gateway-protocol" },
    { dir: "packages/gateway", name: "pi-hermes-gateway-core" },
  ];
  const mapped = workspaceStageMap("/staged", entries);
  assert.deepEqual(mapped.map(({ link }) => link), [
    "/staged/node_modules/pi-hermes-gateway-protocol",
    "/staged/node_modules/pi-hermes-gateway-core",
  ]);
  for (const bad of [
    [{ dir: "../outside", name: "pi-hermes-gateway-protocol" }],
    [{ dir: "/tmp/protocol", name: "pi-hermes-gateway-protocol" }],
    [{ dir: "packages/protocol", name: "attacker-name" }],
    [entries[0], entries[0]],
    [{ dir: "packages/protocol/../../outside", name: "pi-hermes-gateway-protocol" }],
  ]) assert.throws(() => workspaceStageMap("/staged", bad));
  console.log("S6 pure synthetic checks passed");
}

if (process.argv[2] === "--self-test") runSelfTest();
