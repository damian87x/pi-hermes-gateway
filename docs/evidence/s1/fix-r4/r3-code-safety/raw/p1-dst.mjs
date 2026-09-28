// Brute-force oracle for zonedLocalInstant (first fold, null for gaps) and dailyInstantsInRange.
const DIST = process.argv[2];
const { zonedLocalInstant, dailyInstantsInRange } = await import(`${DIST}/schedule.js`);
const zones = ["Australia/Sydney","Australia/Lord_Howe","Pacific/Auckland","Pacific/Chatham","Australia/Adelaide",
  "America/New_York","Europe/London","Europe/Dublin","America/Santiago","America/St_Johns","Antarctica/Troll",
  "Africa/Casablanca","Asia/Gaza","America/Havana","Pacific/Apia","Europe/Moscow","UTC"];
const fmtCache = new Map();
function parts(ms, tz){ let f=fmtCache.get(tz); if(!f){f=new Intl.DateTimeFormat("en-US",{timeZone:tz,hourCycle:"h23",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"});fmtCache.set(tz,f);} const m={}; for(const p of f.formatToParts(new Date(ms))) m[p.type]=p.value; return `${m.year}-${m.month}-${m.day} ${m.hour}:${m.minute}`; }
function offsetMin(ms,tz){ const s=parts(ms,tz); const [d,t]=s.split(" "); const [y,mo,da]=d.split("-").map(Number); const [h,mi]=t.split(":").map(Number); return (Date.UTC(y,mo-1,da,h,mi)-Math.floor(ms/60000)*60000)/60000; }
let checked=0, mismatches=[], transitions=0, dailyChecked=0, dailyMismatch=[];
for (const tz of zones) {
  // find transition instants in 2026 (hourly scan, refine not needed: we test the whole local days around them)
  const start=Date.UTC(2026,0,1), end=Date.UTC(2027,0,1);
  const days=new Set();
  let prev=offsetMin(start,tz);
  for(let t=start+3600e3;t<end;t+=3600e3){ const o=offsetMin(t,tz); if(o!==prev){transitions++; const d=new Date(t); for(const k of [-1,0,1]){ days.add(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()+k)); } } prev=o; }
  if (tz==="UTC") days.add(Date.UTC(2026,5,1));
  for (const dayUtc of days) {
    // oracle map: every UTC minute in [day-3d, day+3d]
    const map=new Map();
    for(let t=dayUtc-3*86400e3;t<dayUtc+3*86400e3;t+=60e3){ const k=parts(t,tz); if(!map.has(k)) map.set(k,[]); map.get(k).push(t); }
    const d=new Date(dayUtc);
    const Y=d.getUTCFullYear(),M=d.getUTCMonth()+1,D=d.getUTCDate();
    for(let h=0;h<24;h++) for(let mi=0;mi<60;mi++){
      const key=`${Y}-${String(M).padStart(2,"0")}-${String(D).padStart(2,"0")} ${String(h).padStart(2,"0")}:${String(mi).padStart(2,"0")}`;
      const cands=map.get(key)||[];
      const want=cands.length?Math.min(...cands):null;
      const got=zonedLocalInstant(tz,Y,M,D,h,mi);
      checked++;
      if(got!==want) mismatches.push({tz,key,want:want&&new Date(want).toISOString(),got:got&&new Date(got).toISOString(),folds:cands.length});
    }
  }
  // daily sequence over full year for a few local times incl. fold/gap-prone ones
  for (const lt of ["00:30","01:30","02:00","02:30","03:00","12:00","23:30"]) {
    const [h,mi]=lt.split(":").map(Number);
    const got=dailyInstantsInRange({timeZone:tz,localTime:lt,afterMs:start,toMs:end});
    // oracle: each local day in range, first matching UTC minute
    const want=[];
    const map=new Map();
    for(let t=start-2*86400e3;t<end+2*86400e3;t+=60e3){ const p=parts(t,tz); if(p.endsWith(` ${lt}`) && !map.has(p)) map.set(p,t); }
    for(const [,t] of map) if(t>start && t<=end) want.push(t);
    want.sort((a,b)=>a-b);
    dailyChecked++;
    if(JSON.stringify(got)!==JSON.stringify(want)) dailyMismatch.push({tz,lt,gotN:got.length,wantN:want.length,firstDiff:got.find((x,i)=>x!==want[i])});
  }
}
console.log(JSON.stringify({zones:zones.length,transitions,localMinutesChecked:checked,mismatchCount:mismatches.length,mismatches:mismatches.slice(0,20),dailySeqChecked:dailyChecked,dailyMismatchCount:dailyMismatch.length,dailyMismatch:dailyMismatch.slice(0,20)},null,1));
// spot values
const spot=(tz,Y,M,D,h,mi)=>{const v=zonedLocalInstant(tz,Y,M,D,h,mi);return `${tz} ${Y}-${M}-${D} ${h}:${mi} -> ${v===null?null:new Date(v).toISOString()}`};
for (const s of [["Australia/Sydney",2026,4,5,2,30],["Australia/Sydney",2026,4,5,1,30],["Australia/Sydney",2026,4,4,1,30],["Australia/Sydney",2026,10,4,2,30],["Pacific/Auckland",2026,4,5,2,30],["Pacific/Auckland",2026,9,27,2,30],["Australia/Lord_Howe",2026,4,5,1,45],["Pacific/Chatham",2026,4,5,3,30]]) console.log(spot(...s));
process.exit(mismatches.length||dailyMismatch.length?1:0);
