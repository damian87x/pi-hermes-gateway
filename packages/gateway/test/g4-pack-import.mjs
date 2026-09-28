import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const gatewayDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const protocolDir = path.resolve(gatewayDir, "../protocol");
const root = path.resolve(gatewayDir, "../..");

function pack(cwd) {
  const packOut = execFileSync("npm", ["pack", "--json"], { cwd, encoding: "utf8" });
  const packed = JSON.parse(packOut);
  return path.join(cwd, packed[0].filename);
}

execFileSync("npm", ["run", "build", "-w", "pi-hermes-gateway-protocol"], { cwd: root, stdio: "inherit" });
execFileSync("npm", ["run", "build", "-w", "pi-hermes-gateway-core"], { cwd: root, stdio: "inherit" });

const protoTar = pack(protocolDir);
const gwTar = pack(gatewayDir);
const protoNames = execFileSync("tar", ["-tzf", protoTar], { encoding: "utf8" }).split("\n").filter(Boolean);
const gwNames = execFileSync("tar", ["-tzf", gwTar], { encoding: "utf8" }).split("\n").filter(Boolean);
for (const name of ["package/package.json", "package/README.md", "package/dist/index.js", "package/dist/fake-adapter.js"]) {
  if (!gwNames.includes(name)) throw new Error(`gateway tarball missing ${name}`);
}
const forbidden = gwNames.filter(
  (name) => name.includes("/src/") || name.includes("/test/") || name.includes("node_modules/"),
);
if (forbidden.length) throw new Error(`packed unexpected paths: ${forbidden.join(", ")}`);

const gwPkg = JSON.parse(readFileSync(path.join(gatewayDir, "package.json"), "utf8"));
if (gwPkg.private !== true) throw new Error("gateway package must be private");
if (gwPkg.pi) throw new Error("gateway package must not contain a pi manifest");
if (gwPkg.peerDependencies && Object.keys(gwPkg.peerDependencies).length) {
  throw new Error("gateway package must not declare peerDependencies");
}
const scripts = gwPkg.scripts || {};
for (const name of Object.keys(scripts)) {
  if (/^(pre|post)?(install|prepare|publish)/.test(name) || name === "prepublishOnly") {
    throw new Error(`lifecycle script ${name}`);
  }
}

const consumer = mkdtempSync(path.join(tmpdir(), "gateway-g4-"));
try {
  writeFileSync(
    path.join(consumer, "package.json"),
    JSON.stringify({ name: "g4-consumer", version: "0.0.0", private: true, type: "module" }),
  );
  execFileSync("npm", ["install", "--ignore-scripts", protoTar, gwTar], { cwd: consumer, stdio: "inherit" });
  writeFileSync(
    path.join(consumer, "import.mjs"),
    `import { createFakeAdapter } from "pi-hermes-gateway-core/fake-adapter";
     import { openGateway, TestClock } from "pi-hermes-gateway-core";
     import { PROTOCOL_VERSION } from "pi-hermes-gateway-protocol";
     const adapter = createFakeAdapter();
     if (adapter.manifest.adapterId !== "fake") throw new Error("fake adapter id");
     if (!adapter.manifest.receiptLevels.includes("accepted")) throw new Error("accepted required");
     if (PROTOCOL_VERSION !== 1) throw new Error("protocol");
     const clock = new TestClock(Date.UTC(2026, 0, 1, 10, 0, 0));
     const { gateway } = openGateway({
       dbPath: ":memory:",
       clock,
       routes: [{ profileId: "p", adapterId: "fake", accountId: "a", chatId: "c" }],
       adapter,
     });
     gateway.close();
     console.log(JSON.stringify({
       protocolVersion: PROTOCOL_VERSION,
       adapterId: adapter.manifest.adapterId,
       maxTextLength: adapter.manifest.maxTextLength,
     }));
    `,
  );
  const imported = execFileSync("node", ["import.mjs"], { cwd: consumer, encoding: "utf8" });
  const mod = JSON.parse(imported.trim().split("\n").at(-1));
  const nested = execFileSync("find", [path.join(consumer, "node_modules"), "-maxdepth", "4", "-type", "d"], {
    encoding: "utf8",
  });
  if (nested.includes("@earendil-works") || nested.includes("pi-coding-agent") || nested.includes("baileys") || nested.includes("telegram")) {
    throw new Error("consumer pulled Pi or transport packages");
  }
  const installedGw = JSON.parse(readFileSync(path.join(consumer, "node_modules/pi-hermes-gateway-core/package.json"), "utf8"));
  if (installedGw.pi) throw new Error("installed gateway has pi key");
  console.log(
    JSON.stringify(
      {
        protocolFiles: protoNames.length,
        gatewayFiles: gwNames.length,
        imported: mod,
        gatewayListing: gwNames,
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(consumer, { recursive: true, force: true });
  rmSync(protoTar, { force: true });
  rmSync(gwTar, { force: true });
}
