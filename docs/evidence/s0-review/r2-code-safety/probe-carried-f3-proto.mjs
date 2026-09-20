const M = "/home/damian-linux/workspace/billioner-coder/apps/pi-hermes-gateway-s0-review-r2/packages/protocol/dist/index.js";
const P = await import(M);
const NOW = Date.UTC(2026,8,20,12,0,0);
console.log("== F3 (carried): prototype pollution, writable props ==");
for (const k of ["profileId","adapterId","accountId","chatId","threadId"]) Object.defineProperty(Object.prototype,k,{value:"evil",configurable:true,writable:true});
const pr = P.validateDeliveryRoute({});
console.log("  validateDeliveryRoute({}) ok =", pr.ok, JSON.stringify(pr.ok?pr.value:pr.error));
for (const k of ["profileId","adapterId","accountId","chatId","threadId"]) delete Object.prototype[k];

console.log("\n== NEW: F1 fix vs prototype-inherited nowMs (opts has no own nowMs) ==");
Object.defineProperty(Object.prototype,"nowMs",{value:NOW,configurable:true,writable:true});
const req={protocolVersion:1,requestId:"req-0001",method:"job.list",body:{},expiresAt:NOW+30000};
const pw = P.validateWireRequest(req,{frameByteLength:200});
console.log("  validateWireRequest(opts without own nowMs) ->", pw.ok? "ACCEPTED via INHERITED clock":"rejected "+pw.error.code);
const pd = P.validateStaticDelivery({route:{profileId:"p1",adapterId:"a1",accountId:"ac1",chatId:"c1",threadId:"t1"},text:"ping",notAfter:NOW+60000},{});
console.log("  validateStaticDelivery(opts without own nowMs) ->", pd.ok? "ACCEPTED via INHERITED clock":"rejected "+pd.error.code);
delete Object.prototype.nowMs;

console.log("\n== Baseline comparison: same probes on BASE-commit behaviour are in R1 evidence (0da0a1d) ==");
