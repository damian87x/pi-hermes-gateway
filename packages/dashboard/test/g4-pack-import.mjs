import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dashDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(dashDir, "../..");

function pack(cwd) {
  const packOut = execFileSync("npm", ["pack", "--json"], { cwd, encoding: "utf8" });
  const packed = JSON.parse(packOut);
  return path.join(cwd, packed[0].filename);
}

execFileSync("npm", ["run", "build", "-w", "pi-hermes-gateway-dashboard"], { cwd: root, stdio: "inherit" });

const dashTar = pack(dashDir);
const names = execFileSync("tar", ["-tzf", dashTar], { encoding: "utf8" }).split("\n").filter(Boolean);
for (const name of ["package/package.json", "package/README.md", "package/dist/index.js"]) {
  if (!names.includes(name)) throw new Error(`dashboard tarball missing ${name}`);
}
const forbidden = names.filter(
  (name) => name.includes("/src/") || name.includes("/test/") || name.includes("node_modules/"),
);
if (forbidden.length) throw new Error(`packed unexpected paths: ${forbidden.join(", ")}`);

const pkg = JSON.parse(readFileSync(path.join(dashDir, "package.json"), "utf8"));
if (pkg.private !== true) throw new Error("dashboard must be private");
if (pkg.pi) throw new Error("dashboard must not contain a pi manifest");
if (pkg.keywords?.includes("pi-package")) throw new Error("dashboard must not be a pi-package");
if (pkg.peerDependencies && Object.keys(pkg.peerDependencies).length) {
  throw new Error("dashboard must not declare peerDependencies");
}
if (pkg.dependencies && Object.keys(pkg.dependencies).length) {
  throw new Error("dashboard must not declare runtime dependencies");
}
const scripts = pkg.scripts || {};
for (const name of Object.keys(scripts)) {
  if (/^(pre|post)?(install|prepare|publish)/.test(name) || name === "prepublishOnly") {
    throw new Error(`lifecycle script ${name}`);
  }
}

const consumer = mkdtempSync(path.join(tmpdir(), "dash-g4-"));
try {
  writeFileSync(
    path.join(consumer, "package.json"),
    JSON.stringify({ name: "g4-consumer", version: "0.0.0", private: true, type: "module" }),
  );
  execFileSync("npm", ["install", "--ignore-scripts", dashTar], { cwd: consumer, stdio: "inherit" });
  writeFileSync(
    path.join(consumer, "import.mjs"),
    `import { createDashboard, collectStatus, LIST_LIMIT } from "pi-hermes-gateway-dashboard";
     if (typeof createDashboard !== "function") throw new Error("createDashboard");
     if (typeof collectStatus !== "function") throw new Error("collectStatus");
     if (!(LIST_LIMIT > 0)) throw new Error("LIST_LIMIT");
     console.log(JSON.stringify({ listLimit: LIST_LIMIT }));
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
    nested.includes("pi-hermes-gateway-core") ||
    nested.includes("pi-hermes-gateway-adapter")
  ) {
    throw new Error("consumer pulled Pi, gateway core, or adapter packages");
  }
  const installed = JSON.parse(
    readFileSync(path.join(consumer, "node_modules/pi-hermes-gateway-dashboard/package.json"), "utf8"),
  );
  if (installed.pi) throw new Error("installed dashboard has pi key");
  console.log(JSON.stringify({ files: names.length, imported: JSON.parse(imported.trim().split("\n").at(-1)) }));
} finally {
  rmSync(consumer, { recursive: true, force: true });
  rmSync(dashTar, { force: true });
}
