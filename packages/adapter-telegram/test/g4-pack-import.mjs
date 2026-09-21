import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const adapterDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const protocolDir = path.resolve(adapterDir, "../protocol");
const root = path.resolve(adapterDir, "../..");

function pack(cwd) {
  const packOut = execFileSync("npm", ["pack", "--json"], { cwd, encoding: "utf8" });
  const packed = JSON.parse(packOut);
  return path.join(cwd, packed[0].filename);
}

execFileSync("npm", ["run", "build", "-w", "pi-hermes-gateway-protocol"], { cwd: root, stdio: "inherit" });
execFileSync("npm", ["run", "build", "-w", "pi-hermes-gateway-adapter-telegram"], { cwd: root, stdio: "inherit" });

const protoTar = pack(protocolDir);
const adapterTar = pack(adapterDir);
const names = execFileSync("tar", ["-tzf", adapterTar], { encoding: "utf8" }).split("\n").filter(Boolean);
for (const name of ["package/package.json", "package/README.md", "package/dist/index.js"]) {
  if (!names.includes(name)) throw new Error(`telegram tarball missing ${name}`);
}
const forbidden = names.filter(
  (name) => name.includes("/src/") || name.includes("/test/") || name.includes("node_modules/"),
);
if (forbidden.length) throw new Error(`packed unexpected paths: ${forbidden.join(", ")}`);

const pkg = JSON.parse(readFileSync(path.join(adapterDir, "package.json"), "utf8"));
if (pkg.private !== true) throw new Error("telegram adapter must be private");
if (pkg.pi) throw new Error("telegram adapter must not contain a pi manifest");
if (pkg.keywords?.includes("pi-package")) throw new Error("telegram adapter must not be a pi-package");
if (pkg.peerDependencies && Object.keys(pkg.peerDependencies).length) {
  throw new Error("telegram adapter must not declare peerDependencies");
}
const scripts = pkg.scripts || {};
for (const name of Object.keys(scripts)) {
  if (/^(pre|post)?(install|prepare|publish)/.test(name) || name === "prepublishOnly") {
    throw new Error(`lifecycle script ${name}`);
  }
}

const consumer = mkdtempSync(path.join(tmpdir(), "telegram-g4-"));
try {
  writeFileSync(
    path.join(consumer, "package.json"),
    JSON.stringify({ name: "g4-consumer", version: "0.0.0", private: true, type: "module" }),
  );
  execFileSync("npm", ["install", "--ignore-scripts", protoTar, adapterTar], { cwd: consumer, stdio: "inherit" });
  writeFileSync(
    path.join(consumer, "import.mjs"),
    `import { createAdapter } from "pi-hermes-gateway-adapter-telegram";
     const adapter = createAdapter({ kind: "dedicated-bot", token: "123456:ABC" });
     if (adapter.manifest.adapterId !== "telegram") throw new Error("adapter id");
     if (typeof adapter.send !== "function") throw new Error("send");
     console.log(JSON.stringify({ adapterId: adapter.manifest.adapterId }));
    `,
  );
  const imported = execFileSync("node", ["import.mjs"], { cwd: consumer, encoding: "utf8" });
  const nested = execFileSync("find", [path.join(consumer, "node_modules"), "-maxdepth", "4", "-type", "d"], {
    encoding: "utf8",
  });
  if (
    nested.includes("@earendil-works") ||
    nested.includes("pi-coding-agent") ||
    nested.includes("baileys") ||
    nested.includes("pi-hermes-gateway-core")
  ) {
    throw new Error("consumer pulled Pi, gateway core, or extra transport packages");
  }
  const installed = JSON.parse(
    readFileSync(path.join(consumer, "node_modules/pi-hermes-gateway-adapter-telegram/package.json"), "utf8"),
  );
  if (installed.pi) throw new Error("installed telegram adapter has pi key");
  console.log(JSON.stringify({ files: names.length, imported: JSON.parse(imported.trim().split("\n").at(-1)) }));
} finally {
  rmSync(consumer, { recursive: true, force: true });
  rmSync(protoTar, { force: true });
  rmSync(adapterTar, { force: true });
}
