// Spec-stage adversarial probe: AC3 concrete limits vs docs/architecture.md table
import * as P from "../../../../packages/protocol/dist/index.js";
const NOW = 1_700_000_000_000;
const route = { profileId: "p1", adapterId: "telegram", accountId: "a1", chatId: "c1" };
const req = (over = {}) => ({ protocolVersion: 1, requestId: "r-1", method: "job.list", body: {}, expiresAt: NOW + 1000, ...over });
const codes = new Set();
const r = (label, res) => {
  if (res && res.ok === false) codes.add(res.error.code);
  console.log(label.padEnd(58), res.ok ? "ok:true" : "ok:false " + res.error.code);
  return res;
};
console.log("=== expiresAt boundary: documented (now, now+60s] ===");
r("expiresAt = now", P.validateWireRequest(req({ expiresAt: NOW }), { nowMs: NOW, frameByteLength: 100 }));
r("expiresAt = now+1", P.validateWireRequest(req({ expiresAt: NOW + 1 }), { nowMs: NOW, frameByteLength: 100 }));
r("expiresAt = now+60000 (upper incl)", P.validateWireRequest(req({ expiresAt: NOW + 60000 }), { nowMs: NOW, frameByteLength: 100 }));
r("expiresAt = now+60001 (over)", P.validateWireRequest(req({ expiresAt: NOW + 60001 }), { nowMs: NOW, frameByteLength: 100 }));
console.log("=== frame boundary: documented max 65536 ===");
r("frameByteLength = 65536", P.validateWireRequest(req(), { nowMs: NOW, frameByteLength: 65536 }));
r("frameByteLength = 65537", P.validateWireRequest(req(), { nowMs: NOW, frameByteLength: 65537 }));
r("frameByteLength = -1", P.validateWireRequest(req(), { nowMs: NOW, frameByteLength: -1 }));
console.log("=== payload boundary: documented max 32768 UTF-8 bytes of JSON.stringify(body) ===");
const mk = (n) => { const b = { deliveryId: "d1", pad: "x".repeat(n) }; return b; };
for (const n of [0, 100]) {
  const body = mk(n);
  const len = Buffer.byteLength(JSON.stringify(body), "utf8");
  r(`delivery.inspect payload ${len} bytes`, P.validateWireRequest(req({ method: "delivery.inspect", body }), { nowMs: NOW, frameByteLength: 100 }));
}
// find exact pad making stringify == 32768 and 32769
let pad = 32768 - Buffer.byteLength(JSON.stringify(mk(0)), "utf8");
for (const [label, extra] of [["==32768", 0], ["==32769", 1]]) {
  const body = mk(pad + extra);
  const len = Buffer.byteLength(JSON.stringify(body), "utf8");
  r(`payload ${label} (actual ${len})`, P.validateWireRequest(req({ method: "delivery.inspect", body }), { nowMs: NOW, frameByteLength: 100 }));
}
console.log("=== multibyte payload counted as UTF-8 bytes not UTF-16 ===");
{
  const body = { deliveryId: "d1", pad: "é".repeat(20000) }; // 2 bytes each => >32768 utf8, 20000 utf16 units
  const len = Buffer.byteLength(JSON.stringify(body), "utf8");
  r(`payload utf8=${len} utf16=${JSON.stringify(body).length}`, P.validateWireRequest(req({ method: "delivery.inspect", body }), { nowMs: NOW, frameByteLength: 100 }));
}
console.log("=== text boundary: documented 4096 UTF-16 code units ===");
const del = (t, na = NOW + 1000) => P.validateStaticDelivery({ route, text: t, notAfter: na }, { nowMs: NOW });
r("text length 4096", del("a".repeat(4096)));
r("text length 4097", del("a".repeat(4097)));
r("text 2048 astral chars (4096 utf16 units)", del("\u{1F600}".repeat(2048)));
r("text 2049 astral chars (4098 utf16 units)", del("\u{1F600}".repeat(2049)));
console.log("=== notAfter boundary: documented (now, now+24h] ===");
r("notAfter = now", del("hi", NOW));
r("notAfter = now+1", del("hi", NOW + 1));
r("notAfter = now+86400000 (upper incl)", del("hi", NOW + 86400000));
r("notAfter = now+86400001 (over)", del("hi", NOW + 86400001));
r("notAfter missing", P.validateStaticDelivery({ route, text: "hi" }, { nowMs: NOW }));
console.log("=== version axis independence (AC2) ===");
console.log("PROTOCOL_VERSION", P.PROTOCOL_VERSION, "ADAPTER_API_VERSION", P.ADAPTER_API_VERSION);
r("wire protocolVersion=2", P.validateWireRequest(req({ protocolVersion: 2 }), { nowMs: NOW, frameByteLength: 100 }));
r("manifest adapterApiVersion=2", P.validateAdapterManifest({ adapterId: "t", adapterApiVersion: 2, capabilities: ["send.text"], configSchemaVersion: 1, maxTextLength: 100, receiptLevels: ["accepted"] }));
r("manifest adapterApiVersion=1 ok", P.validateAdapterManifest({ adapterId: "t", adapterApiVersion: 1, capabilities: ["send.text"], configSchemaVersion: 1, maxTextLength: 100, receiptLevels: ["accepted"] }));
console.log("isAdapterApiCompatible(1,1)", P.isAdapterApiCompatible(1, 1), "(1,2)", P.isAdapterApiCompatible(1, 2), "(1.5,1.5)", P.isAdapterApiCompatible(1.5, 1.5));
console.log("=== F1 regression: invalid caller clock (AC3 bounded expiry) ===");
for (const bad of [undefined, NaN, "1700000000000", 1.5, Infinity, null]) {
  r(`nowMs=${String(bad)} wire`, P.validateWireRequest(req(), { nowMs: bad, frameByteLength: 100 }));
  r(`nowMs=${String(bad)} delivery`, P.validateStaticDelivery({ route, text: "hi", notAfter: NOW + 1000 }, { nowMs: bad }));
}
console.log("=== F2 regression: nonexistent calendar dates (AC3 malformed schedule) ===");
const job = (atUtc) => P.validateMethodBody("job.create", { kind: "static-text", text: "hi", route, schedule: { type: "once", atUtc } }, { nowMs: NOW });
for (const d of ["2026-02-30T00:00:00Z", "2026-04-31T00:00:00Z", "2025-02-29T00:00:00Z", "2026-13-01T00:00:00Z", "2026-00-10T00:00:00Z", "2026-06-31T00:00:00Z", "2026-11-31T00:00:00Z"]) r(`reject? ${d}`, job(d));
for (const d of ["2024-02-29T00:00:00Z", "2026-02-28T23:59:59Z", "2026-01-31T00:00:00Z", "2026-12-31T23:59:59.999Z", "2026-09-21T24:00:00Z"]) r(`accept? ${d}`, job(d));
console.log("=== year 0000-0099 (prior stage nit) ===");
for (const d of ["0050-06-15T00:00:00Z", "0099-01-01T00:00:00Z", "0100-01-01T00:00:00Z"]) r(`accept? ${d}`, job(d));
console.log("=== error codes emitted in this probe ===");
console.log([...codes].sort().join("\n"));
