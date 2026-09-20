// AC2 statelessness/side-effect claims + adjudication of carried findings F3,F4,F5,F6
const D = "../../../../packages/protocol/dist/index.js";
console.log("=== AC2: no automatic side effect on import ===");
const beforeGlobals = new Set(Reflect.ownKeys(globalThis).map(String));
const protoBefore = Reflect.ownKeys(Object.prototype).length;
const P = await import(D);
const afterGlobals = [...new Set(Reflect.ownKeys(globalThis).map(String))].filter((k) => !beforeGlobals.has(k));
console.log("new globals after import:", JSON.stringify(afterGlobals));
console.log("Object.prototype own keys delta:", Reflect.ownKeys(Object.prototype).length - protoBefore);
console.log("exported names:", Object.keys(P).sort().join(","));
console.log("any exported value is a class/Symbol?:", Object.entries(P).filter(([, v]) => typeof v === "symbol" || (typeof v === "function" && /^class\s/.test(Function.prototype.toString.call(v)))).map(([k]) => k).join(",") || "none");
console.log("result objects are plain:", (() => { const r = P.ok({ a: 1 }); return Object.getPrototypeOf(r) === Object.prototype && JSON.stringify(r) === '{"ok":true,"value":{"a":1}}'; })());

console.log("\n=== F4 adjudication: exported constants mutable? ===");
for (const k of ["LIMITS", "METHODS", "KNOWN_CAPABILITIES", "RECEIPT_LEVELS"]) console.log(k, "frozen=", Object.isFrozen(P[k]));
const NOW = 1_700_000_000_000;
const route = { profileId: "p1", adapterId: "telegram", accountId: "a1", chatId: "c1" };
const before = P.validateStaticDelivery({ route, text: "x".repeat(50), notAfter: NOW + 1000 }, { nowMs: NOW });
const orig = P.LIMITS.maxTextChars;
try { P.LIMITS.maxTextChars = 1; } catch (e) { console.log("write threw:", e.message); }
const after = P.validateStaticDelivery({ route, text: "x".repeat(50), notAfter: NOW + 1000 }, { nowMs: NOW });
console.log("same input before mutation:", before.ok, "after LIMITS.maxTextChars=1:", after.ok, after.ok ? "" : after.error.code);
P.LIMITS.maxTextChars = orig;
console.log("(restored)", P.LIMITS.maxTextChars);
// Does module namespace rebinding work? (export binding itself)
try { P.LIMITS = {}; console.log("namespace rebinding allowed: yes"); } catch (e) { console.log("namespace rebinding blocked:", e.constructor.name); }

console.log("\n=== F3 adjudication: prototype-inherited fields accepted? ===");
Object.defineProperty(Object.prototype, "profileId", { value: "evil", configurable: true });
Object.defineProperty(Object.prototype, "adapterId", { value: "evil", configurable: true });
Object.defineProperty(Object.prototype, "accountId", { value: "evil", configurable: true });
Object.defineProperty(Object.prototype, "chatId", { value: "evil", configurable: true });
const polluted = P.validateDeliveryRoute({});
console.log("validateDeliveryRoute({}) with polluted Object.prototype:", JSON.stringify(polluted));
Object.defineProperty(Object.prototype, "protocolVersion", { value: 1, configurable: true });
Object.defineProperty(Object.prototype, "requestId", { value: "r1", configurable: true });
Object.defineProperty(Object.prototype, "method", { value: "job.list", configurable: true });
Object.defineProperty(Object.prototype, "body", { value: {}, configurable: true });
Object.defineProperty(Object.prototype, "expiresAt", { value: NOW + 1000, configurable: true });
const pw = P.validateWireRequest({}, { nowMs: NOW, frameByteLength: 100 });
console.log("validateWireRequest({}) with polluted Object.prototype:", JSON.stringify(pw).slice(0, 200));
console.log("does the package itself pollute? JSON.parse __proto__ test:", (() => { JSON.parse('{"__proto__":{"pwn":1}}'); return Object.prototype.pwn === undefined ? "no" : "YES"; })());
for (const k of ["profileId","adapterId","accountId","chatId","protocolVersion","requestId","method","body","expiresAt"]) delete Object.prototype[k];
console.log("cleanup ok:", P.validateDeliveryRoute({}).ok === false);

console.log("\n=== F5 adjudication: throwing getter escapes total-typed validator? ===");
try {
  const r = P.validateWireRequest({ protocolVersion: 1, requestId: "r1", method: "job.list", get body() { throw new Error("getter boom"); }, expiresAt: NOW + 1000 }, { nowMs: NOW, frameByteLength: 100 });
  console.log("returned:", JSON.stringify(r));
} catch (e) { console.log("THREW out of validator:", e.constructor.name, e.message); }
console.log("JSON-derived input can carry a getter?:", (() => { const o = JSON.parse('{"body":{}}'); return Object.getOwnPropertyDescriptor(o, "body").get !== undefined; })());

console.log("\n=== F6 adjudication: atUtc temporal bound ===");
const job = (atUtc) => P.validateMethodBody("job.create", { kind: "static-text", text: "hi", route, schedule: { type: "once", atUtc } }, { nowMs: NOW });
for (const d of ["1999-01-01T00:00:00Z", "9999-12-31T23:59:59Z", "2026-09-21T00:00:00Z"]) {
  const r = job(d);
  console.log(`atUtc ${d}:`, r.ok ? "ACCEPTED" : "rejected " + r.error.code);
}
console.log("(protocol declares no atUtc horizon; scheduling execution is out of S0 scope per contract)");
