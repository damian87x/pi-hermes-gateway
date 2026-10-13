import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync,
  rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import {
  assertCanonicalPath, assertCanonicalWithin, isolatedEnvironment, requireApprovedProductBoundary,
  requireOwnedTaskHome, workspaceStageMap,
} from "./s6-verify.mjs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const gatewayDir = dirname(testDir);
const packagesDir = dirname(gatewayDir);
const root = dirname(packagesDir);

const PACKAGES = [
  { dir: "protocol", name: "pi-hermes-gateway-protocol", workspace: "pi-hermes-gateway-protocol" },
  { dir: "gateway", name: "pi-hermes-gateway-core", workspace: "pi-hermes-gateway-core" },
  { dir: "adapter-telegram", name: "pi-hermes-gateway-adapter-telegram", workspace: "pi-hermes-gateway-adapter-telegram" },
  { dir: "adapter-whatsapp", name: "pi-hermes-gateway-adapter-whatsapp", workspace: "pi-hermes-gateway-adapter-whatsapp" },
  { dir: "adapter-slack", name: "pi-hermes-gateway-adapter-slack", workspace: "pi-hermes-gateway-adapter-slack" },
  { dir: "pi-companion", name: "pi-hermes-gateway-companion", workspace: "pi-hermes-gateway-companion" },
  { dir: "dashboard", name: "pi-hermes-gateway-dashboard", workspace: "pi-hermes-gateway-dashboard" },
  { dir: "wiki", name: "pi-hermes-gateway-wiki", workspace: "pi-hermes-gateway-wiki" },
] as const;

function writeIsolatedNpmrc(home: string): { userconfig: string; globalconfig: string } {
  const userconfig = join(home, ".npmrc");
  const globalconfig = join(home, "npmrc-global");
  writeFileSync(userconfig, "registry=http://127.0.0.1:9/\n");
  writeFileSync(globalconfig, "registry=http://127.0.0.1:9/\n");
  return { userconfig, globalconfig };
}

function isolatedEnv(home: string): NodeJS.ProcessEnv {
  const config = join(home, "config");
  const cache = join(home, "cache");
  const tmp = join(home, "tmp");
  mkdirSync(config, { recursive: true });
  mkdirSync(cache, { recursive: true });
  mkdirSync(tmp, { recursive: true });
  const { userconfig, globalconfig } = writeIsolatedNpmrc(home);
  // Trust exactly the directory of the node binary already running this test (proven by
  // isNonTamperableSystemFile below) so a nested npm-spawned shell can still resolve node/npm by
  // name on installs where they live outside /usr/bin (e.g. GitHub Actions' hostedtoolcache).
  return isolatedEnvironment(
    { home, tmp, config, cache, npmUserConfig: userconfig, npmGlobalConfig: globalconfig },
    {},
    dirname(NODE),
  );
}

// NODE and npm's CLI path come from the controlled process actually running this test (process.execPath /
// npm_execpath), not a hardcoded machine snapshot, so they are portable to any CI runner or workstation.
const NODE = process.execPath;
const TRUSTED_SYSTEM_DIR_PREFIXES = ["/usr/bin/", "/bin/", "/usr/sbin/", "/sbin/"];

function isNonTamperableSystemFile(path: string): boolean {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) return false;
  if (stat.uid !== 0 && stat.uid !== process.getuid()) return false;
  return (stat.mode & 0o022) === 0;
}

function resolveTrustedSystemExecutable(name: string, candidates: string[]): string {
  for (const candidate of candidates) {
    let resolved: string;
    try {
      resolved = realpathSync(candidate);
    } catch {
      continue;
    }
    if (!TRUSTED_SYSTEM_DIR_PREFIXES.some((prefix) => resolved.startsWith(prefix))) continue;
    if (!isNonTamperableSystemFile(resolved)) continue;
    return resolved;
  }
  throw new Error(`UNPROVEN: no trusted ${name} executable found among ${candidates.join(", ")}`);
}

let cachedNpmCli: string | undefined;
let cachedTar: string | undefined;
let cachedFind: string | undefined;
let cachedGit: string | undefined;

function getNpmCli(): string {
  if (cachedNpmCli) return cachedNpmCli;
  const execpath = process.env.npm_execpath;
  if (!execpath || !execpath.startsWith("/")) {
    throw new Error("UNPROVEN: npm_execpath is not set; this test must run through npm (e.g. npm test) so the real npm CLI is known");
  }
  if (!statSync(execpath).isFile()) throw new Error(`UNPROVEN: npm_execpath does not resolve to a file: ${execpath}`);
  cachedNpmCli = execpath;
  return execpath;
}

function getTar(): string {
  return cachedTar ??= resolveTrustedSystemExecutable("tar", ["/usr/bin/tar", "/bin/tar"]);
}
function getFind(): string {
  return cachedFind ??= resolveTrustedSystemExecutable("find", ["/usr/bin/find", "/bin/find"]);
}
function getGit(): string {
  return cachedGit ??= resolveTrustedSystemExecutable("git", ["/usr/bin/git", "/bin/git"]);
}

// TypeScript is resolved from this repo's own hoisted devDependency (npm workspaces put it at the repo root),
// never a path on one engineer's machine, and its version is checked against the repo's own package.json pin.
const TYPESCRIPT = join(root, "node_modules", "typescript");

const pathResolver = {
  lstat(path: string) {
    return lstatSync(path);
  },
  realpath: realpathSync,
};

// Set once per test run by requireOwnedTaskHome; every subprocess call is bound to this proven home.
let currentTaskHome: string | undefined;

function runProductSubprocess(
  command: string,
  args: string[],
  options: Parameters<typeof execFileSync>[2],
): string | Buffer {
  if (!currentTaskHome) throw new Error("UNPROVEN: no owned task home has been established for this product boundary");
  requireApprovedProductBoundary({
    allowedExecutables: new Set([NODE, getNpmCli(), getTar(), getFind(), getGit()]),
    command,
    args,
    env: (options as { env?: NodeJS.ProcessEnv } | undefined)?.env,
    taskHome: currentTaskHome,
    realHome: process.env.HOME,
    registry: "http://127.0.0.1:9/",
  });
  return execFileSync(command, args, options as never);
}

function npm(args: string[], options: Parameters<typeof execFileSync>[2]): string {
  return runProductSubprocess(NODE, [getNpmCli(), ...args], options) as string;
}

function verifyExecutableInputs(): void {
  if (!isNonTamperableSystemFile(realpathSync(NODE))) throw new Error(`untrusted executable input: ${NODE}`);
  const npmCli = getNpmCli();
  if (!isNonTamperableSystemFile(realpathSync(npmCli))) throw new Error(`untrusted executable input: ${npmCli}`);
  getTar();
  getFind();
  getGit();
}

function verifyCompiler(): void {
  verifyExecutableInputs();
  const rootManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    devDependencies?: Record<string, string>;
  };
  const pinnedVersion = rootManifest.devDependencies?.typescript;
  if (!pinnedVersion) throw new Error("root package.json does not pin a typescript devDependency version");
  const stat = lstatSync(TYPESCRIPT);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("TypeScript artifact is not an owned directory");
  if (stat.uid !== process.getuid()) throw new Error("TypeScript artifact has unexpected owner");
  const manifest = JSON.parse(readFileSync(join(TYPESCRIPT, "package.json"), "utf8")) as { version?: string };
  if (manifest.version !== pinnedVersion) {
    throw new Error(`installed TypeScript ${manifest.version} does not match the pinned devDependency ${pinnedVersion}`);
  }
  for (const file of ["bin/tsc", "lib/tsc.js", "lib/typescript.js", "lib/lib.es5.d.ts"]) {
    if (!statSync(join(TYPESCRIPT, file)).isFile()) throw new Error(`incomplete TypeScript artifact: ${file}`);
  }
}

function bootstrapStaging(work: string, env: NodeJS.ProcessEnv): string {
  verifyCompiler();
  assertCanonicalPath(work, pathResolver);
  const stage = join(work, "source");
  mkdirSync(stage);
  const archive = runProductSubprocess(getGit(), ["archive", "--format=tar", "HEAD"], {
    cwd: root,
    env,
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  }) as Buffer;
  runProductSubprocess(getTar(), ["-xf", "-", "-C", stage], {
    cwd: root,
    env,
    input: archive,
    stdio: "pipe",
    maxBuffer: 64 * 1024 * 1024,
  });
  assertCanonicalPath(stage, pathResolver);
  assertCanonicalWithin(stage, join(stage, "package.json"), pathResolver);
  assertCanonicalWithin(stage, join(stage, "packages"), pathResolver);
  for (const spec of PACKAGES) {
    const packageDir = join(stage, "packages", spec.dir);
    assertCanonicalWithin(stage, packageDir, pathResolver);
    assertCanonicalWithin(stage, join(packageDir, "package.json"), pathResolver);
  }
  const rootManifest = JSON.parse(readFileSync(join(stage, "package.json"), "utf8")) as { workspaces?: unknown };
  const expectedPaths = PACKAGES.map((spec) => `packages/${spec.dir}`);
  const committedWorkspaces = rootManifest.workspaces;
  if (!Array.isArray(committedWorkspaces) || committedWorkspaces.length !== expectedPaths.length
    || expectedPaths.some((path) => !committedWorkspaces.includes(path))) {
    throw new Error("committed workspace list changed or is incomplete");
  }
  const packageMap: { dir: string; name: string }[] = [];
  for (const spec of PACKAGES) {
    const manifest = JSON.parse(readFileSync(join(stage, "packages", spec.dir, "package.json"), "utf8")) as { name?: string };
    packageMap.push({ dir: `packages/${spec.dir}`, name: manifest.name ?? "" });
  }
  const links = workspaceStageMap(stage, packageMap, pathResolver);
  for (const spec of PACKAGES) {
    if (!lstatSync(join(stage, "packages", spec.dir)).isDirectory()) throw new Error(`workspace is not a staged directory: ${spec.dir}`);
  }
  const modules = join(stage, "node_modules");
  assertCanonicalPath(stage, pathResolver);
  mkdirSync(modules);
  const bins = join(modules, ".bin");
  mkdirSync(bins);
  for (const link of links) symlinkSync(relative(dirname(link.link), link.source), link.link, "dir");
  symlinkSync(TYPESCRIPT, join(modules, "typescript"), "dir");
  symlinkSync(join(TYPESCRIPT, "bin", "tsc"), join(bins, "tsc"));
  return stage;
}

function packTo(
  dest: string,
  pkgDir: string,
  env: NodeJS.ProcessEnv,
): { filename: string; name: string; version: string; sha256: string } {
  const packOut = npm(["pack", "--json", "--ignore-scripts", "--pack-destination", dest, "--offline"], {
    cwd: pkgDir,
    encoding: "utf8",
    env,
  });
  const packed = JSON.parse(packOut) as { filename: string; name: string; version: string }[];
  const entry = packed[0];
  if (!entry?.filename) throw new Error(`npm pack produced no filename in ${pkgDir}`);
  const tarball = join(dest, entry.filename);
  return { ...entry, sha256: createHash("sha256").update(readFileSync(tarball)).digest("hex") };
}

function tarList(tarball: string): string[] {
  const listing = runProductSubprocess(getTar(), ["-tzf", tarball], {
    encoding: "utf8",
    env: isolatedEnv(dirname(tarball)),
  }) as string;
  return listing.split("\n").filter(Boolean);
}

function containsPackedSecret(contents: Buffer): boolean {
  const text = contents.toString("utf8");
  return /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)
    || /(?:gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})/.test(text)
    || text.includes("S6_SECRET_CANARY_positive-control");
}

function assertNoPackedSecrets(tarball: string): void {
  const env = isolatedEnv(dirname(tarball));
  const contents = runProductSubprocess(getTar(), ["-xOzf", tarball], {
    encoding: "buffer",
    maxBuffer: 16 * 1024 * 1024,
    env,
  }) as Buffer;
  assert.equal(containsPackedSecret(contents), false, `packed credential in ${tarball}`);
  // GNU tar verbose listings expose member names and link targets, not all raw PAX/xattr metadata.
  const metadata = runProductSubprocess(getTar(), ["-tvzf", tarball], { encoding: "utf8", env }) as string;
  assert.equal(containsPackedSecret(Buffer.from(metadata)), false, `packed credential in archive metadata: ${tarball}`);
}

function install(home: string, tarballs: string[]): string {
  const consumer = mkdtempSync(join(home, "consumer-"));
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({ name: "s6-consumer", version: "0.0.0", private: true, type: "module" }),
  );
  const env = isolatedEnv(home);
  npm(["install", "--omit=dev", "--ignore-scripts", "--no-package-lock", "--offline", ...tarballs], {
    cwd: consumer,
    env,
    encoding: "utf8",
    stdio: "pipe",
  });
  return consumer;
}

function runImport(consumer: string, source: string): string {
  writeFileSync(join(consumer, "import.mjs"), source);
  return runProductSubprocess(NODE, ["import.mjs"], {
    cwd: consumer,
    encoding: "utf8",
    env: isolatedEnv(consumer),
  }) as string;
}

function nestedDirs(consumer: string): string {
  return runProductSubprocess(getFind(), [join(consumer, "node_modules"), "-maxdepth", "4", "-type", "d"], {
    encoding: "utf8",
    env: isolatedEnv(consumer),
  }) as string;
}

test("s6 packed tarballs install in a disposable npm home without publish", { timeout: 180_000 }, () => {
  assert.equal(containsPackedSecret(Buffer.from("S6_SECRET_CANARY_positive-control")), true);
  assert.equal(containsPackedSecret(Buffer.from("ghp_abcdefghijklmnopqrstuvwxyz1234567890")), true);
  assert.equal(containsPackedSecret(Buffer.from("-rw-r--r-- owner/group 32 2026-01-01 package/S6_SECRET_CANARY_positive-control_member-name")), true);
  assert.equal(containsPackedSecret(Buffer.from("lrwxrwxrwx owner/group 32 2026-01-01 package/link -> S6_SECRET_CANARY_positive-control_link-target")), true);
  assert.equal(containsPackedSecret(Buffer.from("ordinary package documentation")), false);
  assert.equal(containsPackedSecret(Buffer.from("-rw-r--r-- owner/group 32 2026-01-01 package/README.md")), false);
  assert.equal(containsPackedSecret(Buffer.from("lrwxrwxrwx owner/group 4 2026-01-01 package/link -> docs")), false);
  for (const spec of PACKAGES) {
    const pkg = JSON.parse(readFileSync(join(packagesDir, spec.dir, "package.json"), "utf8")) as {
      private?: boolean;
      scripts?: Record<string, string>;
      pi?: unknown;
    };
    assert.equal(pkg.private, true);
    const scripts = pkg.scripts ?? {};
    for (const [name, body] of Object.entries(scripts)) {
      assert.equal(/^(pre|post)?(install|prepare|publish)/.test(name) || name === "prepublishOnly", false);
      assert.equal(body.includes("npm publish"), false);
    }
    if (spec.dir === "pi-companion") {
      assert.ok(pkg.pi);
    } else {
      assert.equal(pkg.pi, undefined);
    }
  }
  const doctorSrc = readFileSync(join(root, "packages", "gateway", "src", "doctor.ts"), "utf8");
  const cliSrc = readFileSync(join(root, "packages", "gateway", "src", "cli.ts"), "utf8");
  for (const src of [doctorSrc, cliSrc]) {
    assert.equal(src.includes("npm" + " publish"), false);
    assert.equal(src.includes("systemctl enable"), false);
    assert.equal(src.includes("enable-linger"), false);
  }

  // Self-allocate a disposable, owned task home by default so this proof needs no externally injected
  // environment variable in CI; an operator may still point S6_TASK_HOME at a specific owned directory.
  const requestedTaskHome = process.env.S6_TASK_HOME;
  const ownsAllocatedTaskHome = !requestedTaskHome;
  const allocatedTaskHome = requestedTaskHome ?? mkdtempSync(join(realpathSync(tmpdir()), "s6-task-"));
  const taskHome = requireOwnedTaskHome(pathResolver, process.getuid(), allocatedTaskHome);
  currentTaskHome = taskHome;
  const work = mkdtempSync(join(taskHome, "s6-pack-"));
  try {
    const packEnv = isolatedEnv(work);
    assert.equal(packEnv.npm_config_userconfig, join(work, ".npmrc"));
    assert.equal(packEnv.npm_config_globalconfig, join(work, "npmrc-global"));
    assert.equal(packEnv.npm_config_registry, "http://127.0.0.1:9/");
    assert.notEqual(packEnv.npm_config_userconfig, join(taskHome, ".npmrc"));
    const stage = bootstrapStaging(work, packEnv);
    npm(["run", "build"], { cwd: stage, encoding: "utf8", stdio: "pipe", env: packEnv });
    const tarballs: Record<string, string> = {};
    const listings: Record<string, string[]> = {};
    const identities: Record<string, { name: string; version: string; sha256: string }> = {};
    for (const spec of PACKAGES) {
      const manifest = JSON.parse(readFileSync(join(stage, "packages", spec.dir, "package.json"), "utf8")) as {
        name: string;
        version: string;
      };
      const packed = packTo(work, join(stage, "packages", spec.dir), packEnv);
      assertNoPackedSecrets(join(work, packed.filename));
      assert.equal(packed.name, manifest.name, `${spec.dir} packed name drift`);
      assert.equal(packed.version, manifest.version, `${spec.dir} packed version drift`);
      assert.equal(packed.name, spec.name);
      tarballs[spec.name] = join(work, packed.filename);
      identities[spec.name] = { name: packed.name, version: packed.version, sha256: packed.sha256 };
      listings[spec.name] = tarList(tarballs[spec.name]!);
    }
    console.log(`S6 packed tarball identities: ${JSON.stringify(identities)}`);

    const coreList = listings["pi-hermes-gateway-core"]!;
    for (const name of [
      "package/package.json",
      "package/README.md",
      "package/dist/index.js",
      "package/dist/fake-adapter.js",
      "package/systemd/pi-hermes-gateway@.service",
    ]) {
      assert.ok(coreList.includes(name), `core tarball missing ${name}`);
    }
    const coreJoined = coreList.join("\n");
    assert.equal(coreJoined.includes("adapter-telegram"), false);
    assert.equal(coreJoined.includes("adapter-whatsapp"), false);
    assert.equal(coreJoined.includes("adapter-slack"), false);
    assert.equal(coreJoined.includes("@earendil-works"), false);
    assert.equal(coreJoined.includes("pi-coding-agent"), false);
    assert.equal(coreJoined.includes("baileys"), false);
    assert.equal(coreList.some((n) => n.includes("/src/") || n.includes("/test/") || n.includes("node_modules/")), false);

    const protocolTar = tarballs["pi-hermes-gateway-protocol"]!;
    const coreTar = tarballs["pi-hermes-gateway-core"]!;
    const companionTar = tarballs["pi-hermes-gateway-companion"]!;

    const coreHome = install(work, [protocolTar, coreTar]);
    const coreOut = runImport(
      coreHome,
      `import { createFakeAdapter, openGateway, TestClock } from "pi-hermes-gateway-core";
       import { PROTOCOL_VERSION } from "pi-hermes-gateway-protocol";
       if (PROTOCOL_VERSION !== 1) throw new Error("protocol");
       const adapter = createFakeAdapter();
       if (adapter.manifest.adapterId !== "fake") throw new Error("fake");
       const clock = new TestClock(Date.UTC(2026, 0, 1, 10, 0, 0));
       const { gateway } = openGateway({
         dbPath: ":memory:",
         clock,
         routes: [{ profileId: "p", adapterId: "fake", accountId: "a", chatId: "c" }],
         adapter,
       });
       gateway.close();
       let missing = false;
       try { await import("pi-hermes-gateway-adapter-telegram"); }
       catch { missing = true; }
       if (!missing) throw new Error("core home pulled telegram adapter");
       console.log(JSON.stringify({ core: true, protocolVersion: PROTOCOL_VERSION }));
      `,
    );
    assert.match(coreOut, /"core":true/);
    const coreNested = nestedDirs(coreHome);
    assert.equal(coreNested.includes("@earendil-works"), false);
    assert.equal(coreNested.includes("pi-coding-agent"), false);
    assert.equal(coreNested.includes("baileys"), false);
    assert.equal(coreNested.includes("adapter-telegram"), false);
    assert.equal(coreNested.includes("adapter-whatsapp"), false);
    assert.equal(coreNested.includes("adapter-slack"), false);

    const companionHome = install(work, [protocolTar, companionTar]);
    const companionOut = runImport(
      companionHome,
      `import { companionStatus } from "pi-hermes-gateway-companion";
       import gatewayCompanion from "pi-hermes-gateway-companion/extension";
       const missingProfileStatus = await companionStatus("/no/such/hermes-profile");
       if (missingProfileStatus.ok !== false || missingProfileStatus.available !== false || missingProfileStatus.error.code !== "daemon-unavailable") throw new Error("missing profile status");
       const handlers = new Map();
       const tools = new Map();
       const hostEvents = [];
       gatewayCompanion({
         on(event, handler) { handlers.set(event, handler); hostEvents.push({ type: "registered", event }); },
         registerTool(tool) { tools.set(tool.name, tool); },
       });
       const emit = async (event) => {
         hostEvents.push({ type: "invoked", event });
         return await handlers.get(event)?.();
       };
       if (!handlers.has("session_start")) throw new Error("session_start handler missing");
       const sessionStartResult = await emit("session_start");
       if (sessionStartResult !== undefined) throw new Error("offline session_start should be passive");
       if (!hostEvents.some((event) => event.type === "invoked" && event.event === "session_start")) throw new Error("session_start host event not observed");
       const statusTool = tools.get("gateway_status");
       if (!statusTool) throw new Error("gateway_status handler missing");
       const toolResult = await statusTool.execute();
       const payload = JSON.parse(toolResult.content[0].text);
       if (payload.ok !== false || payload.available !== false || payload.error.code !== "daemon-unavailable") throw new Error("status tool did not report unavailable");
       console.log(JSON.stringify({ unavailable: true, sessionStartAwaited: true, statusHandler: true }));
      `,
    );
    assert.match(companionOut, /"sessionStartAwaited":true/);
    assert.match(companionOut, /"statusHandler":true/);

    const protoHome = install(work, [protocolTar]);
    runImport(
      protoHome,
      `import { ADAPTER_API_VERSION, PROTOCOL_VERSION, validateAdapterManifest, validateWireRequest } from "pi-hermes-gateway-protocol";
       if (PROTOCOL_VERSION !== 1) throw new Error("protocol");
       if (typeof validateWireRequest !== "function") throw new Error("validateWireRequest");
       const incompatible = validateAdapterManifest({
         adapterId: "packed-incompatible",
         adapterApiVersion: ADAPTER_API_VERSION + 1,
         capabilities: ["send.text"],
         configSchemaVersion: 1,
         maxTextLength: 4096,
         receiptLevels: ["accepted"],
       });
       if (incompatible.ok || incompatible.error.code !== "unsupported_adapter_api_version") throw new Error("incompatible adapter API was not rejected");
       console.log("ok");
      `,
    );

    const telegramHome = install(work, [protocolTar, tarballs["pi-hermes-gateway-adapter-telegram"]!]);
    runImport(
      telegramHome,
      `import { createAdapter } from "pi-hermes-gateway-adapter-telegram";
       const adapter = createAdapter({ kind: "dedicated-bot", token: "123456:ABC" });
       if (adapter.manifest.adapterId !== "telegram") throw new Error("telegram id");
       console.log("ok");
      `,
    );

    const waHome = install(work, [protocolTar, tarballs["pi-hermes-gateway-adapter-whatsapp"]!]);
    runImport(
      waHome,
      `import { createAdapter } from "pi-hermes-gateway-adapter-whatsapp";
       const adapter = createAdapter({ kind: "send-only" });
       if (adapter.manifest.adapterId !== "whatsapp") throw new Error("whatsapp id");
       console.log("ok");
      `,
    );

    const slackHome = install(work, [protocolTar, tarballs["pi-hermes-gateway-adapter-slack"]!]);
    runImport(
      slackHome,
      `import { createAdapter } from "pi-hermes-gateway-adapter-slack";
       const adapter = createAdapter({ kind: "bot-token", token: "xoxb-1234567890-ABC" });
       if (adapter.manifest.adapterId !== "slack") throw new Error("slack id");
       console.log("ok");
      `,
    );

    const dashHome = install(work, [tarballs["pi-hermes-gateway-dashboard"]!]);
    runImport(
      dashHome,
      `import { createDashboard, collectStatus } from "pi-hermes-gateway-dashboard";
       if (typeof createDashboard !== "function") throw new Error("createDashboard");
       if (typeof collectStatus !== "function") throw new Error("collectStatus");
       console.log("ok");
      `,
    );

    const wikiHome = install(work, [tarballs["pi-hermes-gateway-wiki"]!]);
    runImport(
      wikiHome,
      `import { compileWiki } from "pi-hermes-gateway-wiki";
       if (typeof compileWiki !== "function") throw new Error("compileWiki");
       console.log("ok");
      `,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
    if (ownsAllocatedTaskHome) rmSync(allocatedTaskHome, { recursive: true, force: true });
    currentTaskHome = undefined;
  }
});
