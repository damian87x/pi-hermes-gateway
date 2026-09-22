import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  const { userconfig, globalconfig } = writeIsolatedNpmrc(home);
  return {
    ...process.env,
    HOME: home,
    npm_config_cache: join(home, "npm-cache"),
    npm_config_prefix: join(home, "prefix"),
    npm_config_userconfig: userconfig,
    npm_config_globalconfig: globalconfig,
    npm_config_registry: "http://127.0.0.1:9/",
    npm_config_update_notifier: "false",
    npm_config_audit: "false",
    npm_config_fund: "false",
  };
}

function packTo(dest: string, pkgDir: string, env: NodeJS.ProcessEnv): string {
  const packOut = execFileSync("npm", ["pack", "--json", "--pack-destination", dest, "--offline"], {
    cwd: pkgDir,
    encoding: "utf8",
    env,
  });
  const packed = JSON.parse(packOut) as { filename: string }[];
  const filename = packed[0]?.filename;
  if (!filename) throw new Error(`npm pack produced no filename in ${pkgDir}`);
  return join(dest, filename);
}

function tarList(tarball: string): string[] {
  return execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }).split("\n").filter(Boolean);
}

function install(home: string, tarballs: string[]): string {
  const consumer = mkdtempSync(join(home, "consumer-"));
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({ name: "s6-consumer", version: "0.0.0", private: true, type: "module" }),
  );
  execFileSync("npm", ["install", "--ignore-scripts", "--no-package-lock", "--offline", ...tarballs], {
    cwd: consumer,
    env: isolatedEnv(home),
    encoding: "utf8",
    stdio: "pipe",
  });
  return consumer;
}

function runImport(consumer: string, source: string): string {
  writeFileSync(join(consumer, "import.mjs"), source);
  return execFileSync(process.execPath, ["import.mjs"], { cwd: consumer, encoding: "utf8" });
}

function nestedDirs(consumer: string): string {
  return execFileSync("find", [join(consumer, "node_modules"), "-maxdepth", "4", "-type", "d"], {
    encoding: "utf8",
  });
}

test("s6 packed tarballs install in a disposable npm home without publish", { timeout: 180_000 }, () => {
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
  const doctorSrc = readFileSync(join(gatewayDir, "src", "doctor.ts"), "utf8");
  const cliSrc = readFileSync(join(gatewayDir, "src", "cli.ts"), "utf8");
  for (const src of [doctorSrc, cliSrc]) {
    assert.equal(src.includes("npm" + " publish"), false);
    assert.equal(src.includes("systemctl enable"), false);
    assert.equal(src.includes("enable-linger"), false);
  }

  const work = mkdtempSync(join(tmpdir(), "s6-pack-"));
  try {
    const packEnv = isolatedEnv(work);
    assert.equal(packEnv.npm_config_userconfig, join(work, ".npmrc"));
    assert.equal(packEnv.npm_config_globalconfig, join(work, "npmrc-global"));
    assert.equal(packEnv.npm_config_registry, "http://127.0.0.1:9/");
    assert.notEqual(packEnv.npm_config_userconfig, process.env.HOME ? join(process.env.HOME, ".npmrc") : packEnv.npm_config_userconfig);
    execFileSync("npm", ["run", "build"], { cwd: root, encoding: "utf8", stdio: "pipe" });
    const tarballs: Record<string, string> = {};
    const listings: Record<string, string[]> = {};
    for (const spec of PACKAGES) {
      tarballs[spec.name] = packTo(work, join(packagesDir, spec.dir), packEnv);
      listings[spec.name] = tarList(tarballs[spec.name]!);
    }

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
      `import { companionStatus, daemonAvailable } from "pi-hermes-gateway-companion";
       if (daemonAvailable("/no/such/hermes-profile")) throw new Error("missing profile available");
       const status = await companionStatus("/no/such/hermes-profile");
       if (status.ok !== false || status.error.code !== "daemon-unavailable") throw new Error("expected unavailable");
       console.log(JSON.stringify({ unavailable: true }));
      `,
    );
    assert.match(companionOut, /"unavailable":true/);

    const protoHome = install(work, [protocolTar]);
    runImport(
      protoHome,
      `import { PROTOCOL_VERSION, validateWireRequest } from "pi-hermes-gateway-protocol";
       if (PROTOCOL_VERSION !== 1) throw new Error("protocol");
       if (typeof validateWireRequest !== "function") throw new Error("validateWireRequest");
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
  }
});
