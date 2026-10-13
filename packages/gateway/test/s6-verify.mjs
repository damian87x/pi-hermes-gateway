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

export function assertCanonicalPath(path, resolver) {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error("path must be absolute and normalized");
  let current = sep;
  for (const component of path.split(sep).filter(Boolean)) {
    current = join(current, component);
    const stat = resolver.lstat(current);
    if (stat.isSymbolicLink() || resolver.realpath(current) !== current) {
      throw new Error("path contains a symlink or noncanonical ancestor");
    }
  }
  return path;
}

export function assertCanonicalWithin(root, path, resolver) {
  assertCanonicalPath(root, resolver);
  assertCanonicalPath(path, resolver);
  const rel = relative(root, path);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("path is outside canonical root");
  }
  return path;
}

export function workspaceStageMap(root, entries, resolver) {
  assertCanonicalPath(root, resolver);
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
    const source = assertCanonicalWithin(root, resolve(root, rel), resolver);
    const fromRoot = relative(root, source);
    if (paths.has(fromRoot)) throw new Error("duplicate workspace path");
    names.add(entry.name);
    paths.add(fromRoot);
    result.push({ name: entry.name, source, link: join(root, "node_modules", entry.name) });
  }
  return result;
}

export function requireOwnedTaskHome(resolver, ownerUid, taskHome) {
  if (typeof taskHome !== "string" || !taskHome.startsWith("/")) {
    throw new Error("UNPROVEN: S6_TASK_HOME is not an explicitly supplied owned task home");
  }
  assertCanonicalPath(taskHome, resolver);
  const stat = resolver.lstat(taskHome);
  if (!stat.isDirectory()) throw new Error("UNPROVEN: task home is not a directory");
  if (stat.uid !== ownerUid) throw new Error("UNPROVEN: task home is not owned by the task user");
  return taskHome;
}

const DENIED_ARG_PATTERNS = [/publish/i, /systemctl/i, /enable-linger/i, /--enable\b/i];
const DENIED_ENV_KEY_PATTERN = /token|secret|password/i;

export function requireApprovedProductBoundary({ allowedExecutables, command, args, env, taskHome, realHome, registry }) {
  if (!allowedExecutables.has(command)) {
    throw new Error(`UNPROVEN: ${command} is not an approved product executable`);
  }
  for (const arg of args) {
    if (typeof arg === "string" && DENIED_ARG_PATTERNS.some((pattern) => pattern.test(arg))) {
      throw new Error(`UNPROVEN: denied action in subprocess argument: ${arg}`);
    }
  }
  if (!env) return;
  for (const key of Object.keys(env)) {
    if (DENIED_ENV_KEY_PATTERN.test(key)) throw new Error(`UNPROVEN: subprocess env carries a credential-shaped key: ${key}`);
  }
  if (env.HOME !== undefined) {
    const resolvedHome = resolve(env.HOME);
    const withinTaskHome = resolvedHome === taskHome || resolvedHome.startsWith(taskHome + sep);
    if (resolvedHome !== env.HOME || resolvedHome === realHome || !withinTaskHome) {
      throw new Error("UNPROVEN: subprocess HOME escapes the owned disposable task home");
    }
  }
  if (env.npm_config_registry !== undefined && env.npm_config_registry !== registry) {
    throw new Error("UNPROVEN: subprocess registry is not the isolated offline sink");
  }
}

export function runSelfTest() {
  const env = isolatedEnvironment({
    home: "/owned/home", tmp: "/owned/tmp", config: "/owned/config", cache: "/owned/cache",
    npmUserConfig: "/owned/home/.npmrc", npmGlobalConfig: "/owned/home/npmrc-global",
  });
  const synthetic = {
    ...env,
    SYNTHETIC_TOKEN: "secret",
    API_KEY: "secret",
    NODE_OPTIONS: "--import=evil",
    LD_PRELOAD: "/untrusted/preload.so",
    npm_config_userconfig: "/untrusted/npmrc",
    npm_config_globalconfig: "/untrusted/global.npmrc",
    NPM_CONFIG_GLOBALCONFIG: "/untrusted/upper.npmrc",
  };
  const clean = isolatedEnvironment({
    home: "/owned/home", tmp: "/owned/tmp", config: "/owned/config", cache: "/owned/cache",
    npmUserConfig: "/owned/home/.npmrc", npmGlobalConfig: "/owned/home/npmrc-global",
  }, synthetic);
  assert.equal(clean.SYNTHETIC_TOKEN, undefined);
  assert.equal(clean.API_KEY, undefined);
  assert.equal(clean.NODE_OPTIONS, undefined);
  assert.equal(clean.LD_PRELOAD, undefined);
  assert.equal(clean.npm_config_userconfig, "/owned/home/.npmrc");
  assert.equal(clean.npm_config_globalconfig, "/owned/home/npmrc-global");
  assert.equal(clean.NPM_CONFIG_GLOBALCONFIG, undefined);
  assert.equal(synthetic.LD_PRELOAD, "/untrusted/preload.so");
  assert.equal(synthetic.npm_config_globalconfig, "/untrusted/global.npmrc");
  assert.equal(synthetic.NPM_CONFIG_GLOBALCONFIG, "/untrusted/upper.npmrc");
  assert.equal(clean.npm_config_cache, "/owned/cache/npm");
  assert.equal(clean.TMPDIR, "/owned/tmp");
  assert.equal(clean.XDG_CONFIG_HOME, "/owned/config");
  assert.equal(clean.PATH, "/usr/bin:/bin");
  assert.equal(synthetic.NODE_OPTIONS, "--import=evil");
  assert.equal(clean.HOME, "/owned/home");

  const syntheticResolver = (symlinks = [], failures = []) => ({
    lstat(path) {
      if (failures.includes(path)) throw new Error("synthetic resolver failure");
      return { isSymbolicLink: () => symlinks.includes(path) };
    },
    realpath(path) {
      if (failures.includes(path)) throw new Error("synthetic resolver failure");
      return path;
    },
  });
  const entries = [
    { dir: "packages/protocol", name: "pi-hermes-gateway-protocol" },
    { dir: "packages/gateway", name: "pi-hermes-gateway-core" },
  ];
  const resolver = syntheticResolver();
  assert.equal(typeof resolver.lstat("/staged").isSymbolicLink, "function");
  assert.doesNotThrow(() => assertCanonicalWithin("/staged", "/staged/packages/protocol", resolver));
  const mapped = workspaceStageMap("/staged", entries, resolver);
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
  ]) assert.throws(() => workspaceStageMap("/staged", bad, resolver));
  for (const [root, path, hostile] of [
    ["/", "/task/home", syntheticResolver(["/task"])],
    ["/", "/staged", syntheticResolver(["/staged"])],
    ["/staged", "/staged/packages/protocol", syntheticResolver(["/staged/packages"])],
    ["/staged", "/staged/inside", syntheticResolver(["/staged/inside"])],
    ["/staged", "/staged/packages/protocol", syntheticResolver([], ["/staged/packages"])],
  ]) assert.throws(() => assertCanonicalWithin(root, path, hostile));
  assert.throws(() => assertCanonicalWithin("/staged", "/staged-sibling/file", resolver));

  const taskHomeResolver = (symlinks = [], isDirectory = true, uid = 4242) => ({
    lstat(path) {
      return { isSymbolicLink: () => symlinks.includes(path), isDirectory: () => isDirectory, uid };
    },
    realpath(path) {
      return path;
    },
  });
  assert.doesNotThrow(() => requireOwnedTaskHome(taskHomeResolver(), 4242, "/owned/task"));
  assert.throws(() => requireOwnedTaskHome(taskHomeResolver(), 4242, undefined), /explicitly supplied owned task home/);
  assert.throws(() => requireOwnedTaskHome(taskHomeResolver(), 4242, "relative/path"), /explicitly supplied owned task home/);
  assert.throws(() => requireOwnedTaskHome(taskHomeResolver([], false), 4242, "/owned/task"), /not a directory/);
  assert.throws(() => requireOwnedTaskHome(taskHomeResolver(), 9999, "/owned/task"), /not owned by the task user/);
  assert.throws(() => requireOwnedTaskHome(taskHomeResolver(["/owned"]), 4242, "/owned/task"), /symlink/);

  const boundaryBase = {
    allowedExecutables: new Map([["/usr/bin/git", "hash"]]),
    command: "/usr/bin/git",
    args: ["archive", "--format=tar", "HEAD"],
    env: { HOME: "/owned/task/work", npm_config_registry: "http://127.0.0.1:9/" },
    taskHome: "/owned/task",
    realHome: "/home/real-user",
    registry: "http://127.0.0.1:9/",
  };
  assert.doesNotThrow(() => requireApprovedProductBoundary(boundaryBase));
  assert.doesNotThrow(() => requireApprovedProductBoundary({ ...boundaryBase, env: undefined }));
  assert.throws(
    () => requireApprovedProductBoundary({ ...boundaryBase, command: "/usr/bin/systemctl" }),
    /not an approved product executable/,
  );
  assert.throws(
    () => requireApprovedProductBoundary({ ...boundaryBase, args: ["publish"] }),
    /denied action in subprocess argument/,
  );
  assert.throws(
    () => requireApprovedProductBoundary({ ...boundaryBase, args: ["...", "systemctl", "enable-linger"] }),
    /denied action in subprocess argument/,
  );
  assert.throws(
    () => requireApprovedProductBoundary({ ...boundaryBase, env: { ...boundaryBase.env, TELEGRAM_TOKEN: "x" } }),
    /credential-shaped key/,
  );
  assert.throws(
    () => requireApprovedProductBoundary({ ...boundaryBase, env: { ...boundaryBase.env, HOME: "/other/place" } }),
    /escapes the owned disposable task home/,
  );
  assert.throws(
    () => requireApprovedProductBoundary({ ...boundaryBase, env: { ...boundaryBase.env, HOME: boundaryBase.realHome } }),
    /escapes the owned disposable task home/,
  );
  assert.throws(
    () => requireApprovedProductBoundary({ ...boundaryBase, env: { ...boundaryBase.env, npm_config_registry: "https://registry.npmjs.org/" } }),
    /not the isolated offline sink/,
  );
  console.log("S6 pure synthetic checks passed");
}

if (process.argv[2] === "--self-test") runSelfTest();
