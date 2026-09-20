import * as p from "/home/damian-linux/workspace/billioner-coder/apps/pi-hermes-gateway-s0-review-r2/packages/protocol/dist/index.js";
const NOW = Date.UTC(2026, 8, 20, 17, 0, 0);
const out = [];
const rec = (name, v) => out.push([name, v]);
const route = { profileId: "p", adapterId: "telegram", accountId: "a", chatId: "1" };

// AC3 exact boundaries: text
for (const n of [p.LIMITS.maxTextChars, p.LIMITS.maxTextChars + 1]) {
  const r = p.validateStaticDelivery({ route, text: "x".repeat(n), notAfter: NOW + 1000 }, { nowMs: NOW });
  rec(`text len ${n}`, r.ok ? "OK" : r.error.code);
}
// UTF-16 surrogate text: 2048 emoji = 4096 code units
const emoji = "\u{1F600}".repeat(2048);
rec(`text 2048 emoji (len=${emoji.length})`, (() => { const r = p.validateStaticDelivery({ route, text: emoji, notAfter: NOW + 1000 }, { nowMs: NOW }); return r.ok ? "OK" : r.error.code; })());

// notAfter boundaries
for (const d of [1, p.LIMITS.maxNotAfterMs, p.LIMITS.maxNotAfterMs + 1, 0, -1]) {
  const r = p.validateStaticDelivery({ route, text: "hi", notAfter: NOW + d }, { nowMs: NOW });
  rec(`notAfter now+${d}`, r.ok ? "OK" : r.error.code);
}
// expiresAt boundaries
const mk = (o) => ({ protocolVersion: 1, requestId: "r1", method: "delivery.inspect", body: { deliveryId: "d1" }, expiresAt: NOW + 5000, ...o });
for (const d of [1, p.LIMITS.maxRequestTtlMs, p.LIMITS.maxRequestTtlMs + 1, 0]) {
  const r = p.validateWireRequest(mk({ expiresAt: NOW + d }), { nowMs: NOW, frameByteLength: 100 });
  rec(`expiresAt now+${d}`, r.ok ? "OK" : r.error.code);
}
// frame boundary
for (const f of [p.LIMITS.maxFrameBytes, p.LIMITS.maxFrameBytes + 1, -1, 1.5]) {
  const r = p.validateWireRequest(mk({}), { nowMs: NOW, frameByteLength: f });
  rec(`frame ${f}`, r.ok ? "OK" : r.error.code);
}
// payload boundary: build body whose JSON.stringify utf8 length == exactly limit and limit+1
const overhead = JSON.stringify({ deliveryId: "" }).length;
for (const extra of [0, 1]) {
  const v = "d".repeat(p.LIMITS.maxPayloadBytes - overhead + extra);
  const body = { deliveryId: v };
  const bytes = Buffer.byteLength(JSON.stringify(body), "utf8");
  const r = p.validateWireRequest(mk({ body }), { nowMs: NOW, frameByteLength: 100 });
  rec(`payload ${bytes} bytes`, r.ok ? "OK(route-invalid-ok)" : r.error.code);
}
// prototype pollution propagation
const poison = JSON.parse('{"route":{"profileId":"p","adapterId":"t","accountId":"a","chatId":"1","__proto__":{"polluted":true}},"text":"hi","notAfter":' + (NOW + 1000) + '}');
const pr = p.validateStaticDelivery(poison, { nowMs: NOW });
rec("proto-pollution accepted", pr.ok ? "OK" : pr.error.code);
rec("Object.prototype.polluted", String({}.polluted));
rec("result has own __proto__ key", pr.ok ? String(Object.prototype.hasOwnProperty.call(pr.value.route, "__proto__")) : "n/a");

// AC3 job.create once schedule in the PAST (nowMs is accepted but unused)
const past = p.validateMethodBody("job.create", { kind: "static-text", text: "hi", route, schedule: { type: "once", atUtc: "1970-01-01T00:00:00Z" } }, { nowMs: NOW });
rec("job.create once atUtc=1970 (past)", past.ok ? "ACCEPTED" : past.error.code);
const far = p.validateMethodBody("job.create", { kind: "static-text", text: "hi", route, schedule: { type: "once", atUtc: "9999-12-31T23:59:59Z" } }, { nowMs: NOW });
rec("job.create once atUtc=9999 (far future)", far.ok ? "ACCEPTED" : far.error.code);

// adapter API independence + non-integer versions
rec("adapterApiVersion 1.5", (() => { const r = p.validateAdapterManifest({ adapterId: "a", adapterApiVersion: 1.5, capabilities: ["send.text"], configSchemaVersion: 1, maxTextLength: 10, receiptLevels: ["accepted"] }); return r.ok ? "OK" : r.error.code; })());
rec("PROTOCOL_VERSION vs ADAPTER_API_VERSION independent consts", `${p.PROTOCOL_VERSION}/${p.ADAPTER_API_VERSION} sameRef=${Object.is(p.PROTOCOL_VERSION, p.ADAPTER_API_VERSION)}`);

// no ambient globals / side effects: module surface
rec("exports count", Object.keys(p).length);
rec("exported names", Object.keys(p).join(","));
for (const [k, v] of out) console.log(`${k} => ${v}`);
