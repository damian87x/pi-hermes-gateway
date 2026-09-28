import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const companionDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const protocolDir = path.resolve(companionDir, "../protocol");
const root = path.resolve(companionDir, "../..");

function pack(cwd) {
  const packOut = execFileSync("npm", ["pack", "--json"], { cwd, encoding: "utf8" });
  const packed = JSON.parse(packOut);
  return path.join(cwd, packed[0].filename);
}

execFileSync("npm", ["run", "build", "-w", "pi-hermes-gateway-protocol"], { cwd: root, stdio: "inherit" });
execFileSync("npm", ["run", "build", "-w", "pi-hermes-gateway-companion"], { cwd: root, stdio: "inherit" });

const protoTar = pack(protocolDir);
const companionTar = pack(companionDir);
const names = execFileSync("tar", ["-tzf", companionTar], { encoding: "utf8" }).split("\n").filter(Boolean);
for (const name of ["package/package.json", "package/README.md", "package/dist/index.js", "package/dist/extension.js"]) {
  if (!names.includes(name)) throw new Error(`companion tarball missing ${name}`);
}
const forbidden = names.filter(
  (name) => name.includes("/src/") || name.includes("/test/") || name.includes("node_modules/"),
);
if (forbidden.length) throw new Error(`packed unexpected paths: ${forbidden.join(", ")}`);

const pkg = JSON.parse(readFileSync(path.join(companionDir, "package.json"), "utf8"));
if (pkg.private !== true) throw new Error("companion must be private");
if (!pkg.keywords?.includes("pi-package")) throw new Error("companion must include pi-package keyword");
if (!pkg.pi?.extensions) throw new Error("companion must declare pi.extensions");
const scripts = pkg.scripts || {};
for (const name of Object.keys(scripts)) {
  if (/^(pre|post)?(install|prepare|publish)/.test(name) || name === "prepublishOnly") {
    throw new Error(`lifecycle script ${name}`);
  }
}

const consumer = mkdtempSync(path.join(tmpdir(), "companion-g4-"));
try {
  writeFileSync(
    path.join(consumer, "package.json"),
    JSON.stringify({ name: "g4-consumer", version: "0.0.0", private: true, type: "module" }),
  );
  execFileSync("npm", ["install", "--ignore-scripts", protoTar, companionTar], { cwd: consumer, stdio: "inherit" });
  writeFileSync(
    path.join(consumer, "import.mjs"),
    `import { companionStatus, daemonAvailable } from "pi-hermes-gateway-companion";
     import gatewayCompanion from "pi-hermes-gateway-companion/extension";
     if (daemonAvailable("/no/such/profile")) throw new Error("missing profile must be unavailable");
     const status = await companionStatus("/no/such/profile");
     if (status.ok !== false || status.error.code !== "daemon-unavailable") throw new Error("expected unavailable");
     let started = false;
     gatewayCompanion({ on() { started = true; } });
     if (!started) throw new Error("extension factory must register session_start only");
     console.log(JSON.stringify({ unavailable: true }));
    `,
  );
  const imported = execFileSync("node", ["import.mjs"], { cwd: consumer, encoding: "utf8" });
  const nested = execFileSync("find", [path.join(consumer, "node_modules"), "-maxdepth", "4", "-type", "d"], {
    encoding: "utf8",
  });
  if (nested.includes("@earendil-works") || nested.includes("baileys") || nested.includes("adapter-telegram")) {
    throw new Error("companion consumer pulled Pi or telegram adapter");
  }
  console.log(JSON.stringify({ files: names.length, imported: JSON.parse(imported.trim().split("\n").at(-1)) }));
} finally {
  rmSync(consumer, { recursive: true, force: true });
  rmSync(protoTar, { force: true });
  rmSync(companionTar, { force: true });
}
