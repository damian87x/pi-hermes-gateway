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
execFileSync("npm", ["run", "build", "-w", "pi-hermes-gateway-adapter-whatsapp"], { cwd: root, stdio: "inherit" });

const protoTar = pack(protocolDir);
const adapterTar = pack(adapterDir);
const names = execFileSync("tar", ["-tzf", adapterTar], { encoding: "utf8" }).split("\n").filter(Boolean);
for (const name of ["package/package.json", "package/README.md", "package/dist/index.js"]) {
  if (!names.includes(name)) throw new Error(`whatsapp tarball missing ${name}`);
}
const forbidden = names.filter(
  (name) => name.includes("/src/") || name.includes("/test/") || name.includes("node_modules/"),
);
if (forbidden.length) throw new Error(`packed unexpected paths: ${forbidden.join(", ")}`);

const pkg = JSON.parse(readFileSync(path.join(adapterDir, "package.json"), "utf8"));
if (pkg.private !== true) throw new Error("whatsapp adapter must be private");
if (pkg.pi) throw new Error("whatsapp adapter must not contain a pi manifest");
if (pkg.keywords?.includes("pi-package")) throw new Error("whatsapp adapter must not be a pi-package");
if (pkg.peerDependencies && Object.keys(pkg.peerDependencies).length) {
  throw new Error("whatsapp adapter must not declare peerDependencies");
}
if (pkg.dependencies?.baileys || pkg.dependencies?.["@whiskeysockets/baileys"]) {
  throw new Error("whatsapp adapter must not depend on baileys in this slice");
}
if (pkg.optionalDependencies && Object.keys(pkg.optionalDependencies).length) {
  throw new Error("whatsapp adapter must not declare optionalDependencies");
}
const depNames = Object.keys(pkg.dependencies ?? {});
if (depNames.length !== 1 || depNames[0] !== "pi-hermes-gateway-protocol") {
  throw new Error(`whatsapp adapter runtime dependency must be exactly pi-hermes-gateway-protocol, got ${depNames.join(",")}`);
}
const readme = readFileSync(path.join(adapterDir, "README.md"), "utf8");
if (!/socket factory/i.test(readme) || !readme.includes("pi-hermes-gateway-protocol")) {
  throw new Error("whatsapp README must document the operator-supplied socket factory and the sole runtime dependency");
}
const scripts = pkg.scripts || {};
for (const name of Object.keys(scripts)) {
  if (/^(pre|post)?(install|prepare|publish)/.test(name) || name === "prepublishOnly") {
    throw new Error(`lifecycle script ${name}`);
  }
}

const consumer = mkdtempSync(path.join(tmpdir(), "whatsapp-g4-"));
try {
  writeFileSync(
    path.join(consumer, "package.json"),
    JSON.stringify({ name: "g4-consumer", version: "0.0.0", private: true, type: "module" }),
  );
  execFileSync("npm", ["install", "--ignore-scripts", protoTar, adapterTar], { cwd: consumer, stdio: "inherit" });
  writeFileSync(
    path.join(consumer, "import.mjs"),
    `import { createAdapter, defaultWhatsAppSend, whatsAppAuthDir } from "pi-hermes-gateway-adapter-whatsapp";
     const bare = defaultWhatsAppSend({ jid: "1001@s.whatsapp.net", text: "hi", timeoutMs: 10 });
     if (!bare || bare.kind !== "unconfigured") throw new Error("default sender must be unconfigured without a socket factory");
     if (typeof whatsAppAuthDir !== "function") throw new Error("whatsAppAuthDir");
     const adapter = createAdapter({ kind: "send-only" }, { send: defaultWhatsAppSend });
     if (adapter.manifest.adapterId !== "whatsapp") throw new Error("adapter id");
     if (typeof adapter.send !== "function") throw new Error("send");
     const route = { profileId: "p", adapterId: "whatsapp", accountId: "a", chatId: "1001@s.whatsapp.net" };
     const receipt = adapter.send({ deliveryId: "g4", route, text: "hi" });
     if (receipt.receiptLevel !== "commit-unknown" || receipt.reason !== "whatsapp-socket-unconfigured") {
       throw new Error("unconfigured default sender must be commit-unknown and send nothing");
     }
     console.log(JSON.stringify({ adapterId: adapter.manifest.adapterId, reason: receipt.reason }));
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
    readFileSync(path.join(consumer, "node_modules/pi-hermes-gateway-adapter-whatsapp/package.json"), "utf8"),
  );
  if (installed.pi) throw new Error("installed whatsapp adapter has pi key");
  console.log(JSON.stringify({ files: names.length, imported: JSON.parse(imported.trim().split("\n").at(-1)) }));
} finally {
  rmSync(consumer, { recursive: true, force: true });
  rmSync(protoTar, { force: true });
  rmSync(adapterTar, { force: true });
}
