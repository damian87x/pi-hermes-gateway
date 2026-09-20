import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const protocolDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packOut = execFileSync("npm", ["pack", "--json"], { cwd: protocolDir, encoding: "utf8" });
const packed = JSON.parse(packOut);
const filename = packed[0].filename;
const tarball = path.join(protocolDir, filename);
const listing = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" });
const names = listing.split("\n").filter(Boolean);
const required = [
  "package/package.json",
  "package/README.md",
  "package/dist/index.js",
  "package/dist/index.d.ts",
];
for (const name of required) {
  if (!names.includes(name)) throw new Error(`packed tarball missing ${name}`);
}
const forbidden = names.filter(
  (name) =>
    name.includes("/src/") ||
    name.includes("/test/") ||
    name.endsWith("tsconfig.json") ||
    name.includes("node_modules/"),
);
if (forbidden.length) throw new Error(`packed unexpected paths: ${forbidden.join(", ")}`);

const pkg = JSON.parse(readFileSync(path.join(protocolDir, "package.json"), "utf8"));
if (pkg.private !== true) throw new Error("protocol package must be private");
if (pkg.pi) throw new Error("protocol package must not contain a pi manifest");
if (pkg.peerDependencies && Object.keys(pkg.peerDependencies).length) {
  throw new Error("protocol package must not declare peerDependencies");
}
if (pkg.dependencies && Object.keys(pkg.dependencies).length) {
  throw new Error("protocol package must not declare runtime dependencies");
}

const consumer = mkdtempSync(path.join(tmpdir(), "protocol-g4-"));
try {
  writeFileSync(
    path.join(consumer, "package.json"),
    JSON.stringify({ name: "g4-consumer", version: "0.0.0", private: true, type: "module" }),
  );
  execFileSync("npm", ["install", "--ignore-scripts", tarball], { cwd: consumer, stdio: "inherit" });
  writeFileSync(
    path.join(consumer, "import.mjs"),
    `import * as proto from "pi-hermes-gateway-protocol";
     if (typeof proto.validateWireRequest !== "function") throw new Error("import missing validateWireRequest");
     if (proto.PROTOCOL_VERSION !== 1) throw new Error("unexpected PROTOCOL_VERSION");
     console.log(JSON.stringify({ protocolVersion: proto.PROTOCOL_VERSION, adapterApiVersion: proto.ADAPTER_API_VERSION }));\n`,
  );
  const imported = execFileSync("node", ["import.mjs"], { cwd: consumer, encoding: "utf8" });
  const mod = JSON.parse(imported);
  const installedPkg = JSON.parse(
    readFileSync(path.join(consumer, "node_modules/pi-hermes-gateway-protocol/package.json"), "utf8"),
  );
  if (installedPkg.pi) throw new Error("installed protocol has pi key");
  const nested = execFileSync("find", [path.join(consumer, "node_modules"), "-maxdepth", "3", "-type", "d"], {
    encoding: "utf8",
  });
  if (nested.includes("@earendil-works") || nested.includes("pi-coding-agent") || nested.includes("baileys")) {
    throw new Error("consumer pulled Pi or transport packages");
  }
  console.log(
    JSON.stringify(
      {
        tarball: filename,
        files: names.length,
        listing: names,
        imported: mod,
        protocolVersion: mod.protocolVersion,
        adapterApiVersion: mod.adapterApiVersion,
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(consumer, { recursive: true, force: true });
  rmSync(tarball, { force: true });
}
