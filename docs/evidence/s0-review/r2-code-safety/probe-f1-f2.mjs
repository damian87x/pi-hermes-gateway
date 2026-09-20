import * as P from "/home/damian-linux/workspace/billioner-coder/apps/pi-hermes-gateway-s0-review-r2/packages/protocol/dist/index.js";
const NOW = Date.UTC(2026, 8, 20, 12, 0, 0);
const route = { profileId:"p1", adapterId:"a1", accountId:"acc1", chatId:"c1", threadId:"t1" };
const req = (over={}) => ({ protocolVersion:1, requestId:"req-0001", method:"job.list", body:{}, expiresAt: NOW+30000, ...over });
const frame = (o) => Buffer.byteLength(JSON.stringify(o), "utf8");
const BAD = [undefined, NaN, null, "1", 1.5, Infinity, -Infinity, {}, [], true, 1n===1n?0.0000001:0];
const out = { F1_validateWireRequest:[], F1_validateStaticDelivery:[], F1_validateMethodBody_deliveryEnqueue:[], F1_validateMethodBody_jobCreate:[], F1_valid_clock_control:[], F2_reject:[], F2_accept:[], F2_edge:[] };
const d = (over={}) => ({ route, text:"ping", notAfter: NOW+60000, ...over });

for (const n of BAD) {
  const r = P.validateWireRequest(req(), { nowMs: n, frameByteLength: frame(req()) });
  out.F1_validateWireRequest.push({ nowMs:String(n), ok:r.ok, code: r.ok?null:r.error.code });
  const r2 = P.validateStaticDelivery(d(), { nowMs: n });
  out.F1_validateStaticDelivery.push({ nowMs:String(n), ok:r2.ok, code: r2.ok?null:r2.error.code });
  const r3 = P.validateMethodBody("delivery.enqueue", d(), { nowMs: n });
  out.F1_validateMethodBody_deliveryEnqueue.push({ nowMs:String(n), ok:r3.ok, code: r3.ok?null:r3.error.code });
  const r4 = P.validateMethodBody("job.create", { kind:"static-text", text:"ping", route, schedule:{type:"once",atUtc:"2026-12-01T00:00:00Z"} }, { nowMs: n });
  out.F1_validateMethodBody_jobCreate.push({ nowMs:String(n), ok:r4.ok, code: r4.ok?null:r4.error.code });
}
// control: valid clock still works, expiry still enforced
out.F1_valid_clock_control.push({ case:"valid now, valid expiry", ok: P.validateWireRequest(req(), {nowMs:NOW, frameByteLength:frame(req())}).ok });
const exp = P.validateWireRequest(req({expiresAt: NOW-1}), {nowMs:NOW, frameByteLength:frame(req({expiresAt:NOW-1}))});
out.F1_valid_clock_control.push({ case:"expired", ok:exp.ok, code: exp.ok?null:exp.error.code });
const far = P.validateWireRequest(req({expiresAt: NOW+600000}), {nowMs:NOW, frameByteLength:frame(req({expiresAt:NOW+600000}))});
out.F1_valid_clock_control.push({ case:"beyond TTL", ok:far.ok, code: far.ok?null:far.error.code });
out.F1_valid_clock_control.push({ case:"delivery valid", ok: P.validateStaticDelivery(d(), {nowMs:NOW}).ok });

const jc = (atUtc) => P.validateMethodBody("job.create", { kind:"static-text", text:"ping", route, schedule:{type:"once",atUtc} }, { nowMs: NOW });
for (const a of ["2026-02-30T00:00:00Z","2026-04-31T00:00:00Z","2026-06-31T00:00:00Z","2026-09-31T00:00:00Z","2026-11-31T00:00:00Z","2026-02-29T00:00:00Z","1900-02-29T00:00:00Z","2100-02-29T00:00:00Z","2026-02-30T00:00:00.000Z","2026-04-31T23:59:59.999Z","2026-01-32T00:00:00Z","2026-00-10T00:00:00Z","2026-13-01T00:00:00Z","2026-09-20T00:00:60Z","2026-09-20T25:00:00Z"]) {
  const r = jc(a); out.F2_reject.push({ atUtc:a, ok:r.ok, code:r.ok?null:r.error.code, resolvesTo: r.ok? new Date(Date.parse(a)).toISOString():null });
}
for (const a of ["2026-09-21T00:00:00Z","2026-09-21T00:00:00.000Z","2026-09-21T00:00:00.123Z","2024-02-29T00:00:00Z","2000-02-29T00:00:00Z","2026-02-28T23:59:59Z","2026-01-31T00:00:00Z","2026-03-31T00:00:00Z","2026-04-30T00:00:00Z","2026-12-31T23:59:59.999Z","2026-09-21T24:00:00Z","2024-02-29T24:00:00Z","2026-09-21T24:00:00.000Z"]) {
  const r = jc(a); out.F2_accept.push({ atUtc:a, ok:r.ok, code:r.ok?null:r.error.code });
}
for (const a of ["0000-01-01T00:00:00Z","0050-06-15T00:00:00Z","0099-12-31T00:00:00Z","0100-01-01T00:00:00Z","1999-01-01T00:00:00Z","9999-01-01T00:00:00Z"]) {
  const r = jc(a); out.F2_edge.push({ atUtc:a, ok:r.ok, code:r.ok?null:r.error.code, dateParseFinite: Number.isFinite(Date.parse(a)) });
}
console.log(JSON.stringify(out, null, 2));
