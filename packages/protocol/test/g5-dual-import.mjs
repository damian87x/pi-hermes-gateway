import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const protocolDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(protocolDir, "dist");
const root = mkdtempSync(path.join(tmpdir(), "protocol-g5-"));

function writeCopy(name) {
  const dir = path.join(root, name);
  cpSync(dist, path.join(dir, "dist"), { recursive: true });
  writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: `copy-${name}`,
      version: "0.0.0",
      private: true,
      type: "module",
      exports: { ".": { import: "./dist/index.js", types: "./dist/index.d.ts" } },
    }),
  );
  return dir;
}

const aDir = writeCopy("a");
const bDir = writeCopy("b");
const a = await import(pathToFileURL(path.join(aDir, "dist/index.js")).href);
const b = await import(pathToFileURL(path.join(bDir, "dist/index.js")).href);

if (a === b) throw new Error("module namespace objects must not be identical across copies");
if (a.validateAdapterManifest === b.validateAdapterManifest) {
  throw new Error("function identity must not be shared across distinct module roots");
}

const manifest = {
  adapterId: "fake-file",
  adapterApiVersion: 1,
  capabilities: ["send.text"],
  configSchemaVersion: 1,
  maxTextLength: 32,
  receiptLevels: ["accepted"],
};
const nowMs = Date.UTC(2026, 8, 20, 17, 0, 0);
const delivery = {
  route: { profileId: "profile-a", adapterId: "telegram", accountId: "bot-1", chatId: "123" },
  text: "hello",
  notAfter: nowMs + 60_000,
};

const aMan = a.validateAdapterManifest(manifest);
const bMan = b.validateAdapterManifest(manifest);
if (!aMan.ok || !bMan.ok) throw new Error("plain manifest should validate in both copies");
if (JSON.stringify(aMan.value) !== JSON.stringify(bMan.value)) {
  throw new Error("validated manifests differ across module roots");
}

const aDel = a.validateStaticDelivery(delivery, { nowMs });
const bDel = b.validateStaticDelivery(delivery, { nowMs });
if (!aDel.ok || !bDel.ok) throw new Error("plain delivery should validate in both copies");
if (JSON.stringify(aDel.value) !== JSON.stringify(bDel.value)) {
  throw new Error("validated deliveries differ across module roots");
}

if (a.PROTOCOL_VERSION !== b.PROTOCOL_VERSION || a.ADAPTER_API_VERSION !== b.ADAPTER_API_VERSION) {
  throw new Error("version constants should match by value");
}
if (a.isAdapterApiCompatible(2, 1) !== false || b.isAdapterApiCompatible(1, 1) !== true) {
  throw new Error("API compatibility is not structural");
}

console.log(
  JSON.stringify(
    {
      distinctModules: a !== b,
      distinctFns: a.validateAdapterManifest !== b.validateAdapterManifest,
      protocolVersion: a.PROTOCOL_VERSION,
      adapterApiVersion: a.ADAPTER_API_VERSION,
      manifest: aMan.value,
    },
    null,
    2,
  ),
);

rmSync(root, { recursive: true, force: true });
