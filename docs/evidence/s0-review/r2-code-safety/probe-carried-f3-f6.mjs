const M = "/home/damian-linux/workspace/billioner-coder/apps/pi-hermes-gateway-s0-review-r2/packages/protocol/dist/index.js";
const P = await import(M);
const NOW = Date.UTC(2026,8,20,12,0,0);
const route = { profileId:"p1", adapterId:"a1", accountId:"acc1", chatId:"c1", threadId:"t1" };
console.log("== ROOT CAUSE of year 0000-0099 rejection (jobs.ts:35 Date.UTC legacy 2-digit year mapping) ==");
for (const y of [0,50,99,100,1999]) console.log(`  Date.UTC(${y},0,1).getUTCFullYear() =`, new Date(Date.UTC(y,0,1)).getUTCFullYear(), "| input year", y, "=> roundtrip match:", new Date(Date.UTC(y,0,1)).getUTCFullYear()===y);
console.log("  Date.parse('0050-06-15T00:00:00Z') ->", new Date(Date.parse("0050-06-15T00:00:00Z")).toISOString());

console.log("\n== F6 (carried): atUtc has no temporal bound ==");
const jc=(a)=>P.validateMethodBody("job.create",{kind:"static-text",text:"ping",route,schedule:{type:"once",atUtc:a}},{nowMs:NOW});
for (const a of ["1999-01-01T00:00:00Z","9999-01-01T00:00:00Z"]) console.log("  ",a,"ok=",jc(a).ok);

console.log("\n== F4 (carried): LIMITS not frozen ==");
console.log("  isFrozen(LIMITS) =", Object.isFrozen(P.LIMITS), "| isFrozen(METHODS) =", Object.isFrozen(P.METHODS), "| isFrozen(KNOWN_CAPABILITIES) =", Object.isFrozen(P.KNOWN_CAPABILITIES), "| isFrozen(RECEIPT_LEVELS) =", Object.isFrozen(P.RECEIPT_LEVELS));

console.log("\n== F5 (carried): throwing getter escapes validateWireRequest ==");
try { P.validateWireRequest({protocolVersion:1,requestId:"req-0001",method:"job.list",expiresAt:NOW+1000,get body(){throw new Error("boom");}},{nowMs:NOW,frameByteLength:100}); console.log("  no throw"); }
catch(e){ console.log("  THROWS raw:", e.message); }

console.log("\n== F3 (carried): prototype pollution synthesises valid objects ==");
Object.defineProperty(Object.prototype,"profileId",{value:"evil",configurable:true});
Object.defineProperty(Object.prototype,"adapterId",{value:"evil",configurable:true});
Object.defineProperty(Object.prototype,"accountId",{value:"evil",configurable:true});
Object.defineProperty(Object.prototype,"chatId",{value:"evil",configurable:true});
Object.defineProperty(Object.prototype,"threadId",{value:"evil",configurable:true});
const pr = P.validateDeliveryRoute({});
console.log("  validateDeliveryRoute({}) ok =", pr.ok, JSON.stringify(pr.ok?pr.value:pr.error));
for (const k of ["profileId","adapterId","accountId","chatId","threadId"]) delete Object.prototype[k];

console.log("\n== NEW: does the F1 fix survive prototype-polluted opts? (nowMs inherited) ==");
Object.defineProperty(Object.prototype,"nowMs",{value:NOW,configurable:true});
const pw = P.validateWireRequest({protocolVersion:1,requestId:"req-0001",method:"job.list",body:{},expiresAt:NOW+30000},{frameByteLength:200});
console.log("  validateWireRequest with opts lacking own nowMs ->", pw.ok? "ACCEPTED via inherited clock":"rejected "+pw.error.code);
delete Object.prototype.nowMs;
