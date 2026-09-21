// DST first-fold / gap correctness vs brute-force minute scan.
import { zonedLocalInstant, dailyInstantsInRange } from "/tmp/s1r1-clone/packages/gateway/dist/index.js";
function brute(tz, y, m, d, h, mi) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const base = Date.UTC(y, m - 1, d, h, mi) - 16 * 3600e3; const out = [];
  for (let t = base; t <= base + 32 * 3600e3; t += 60e3) {
    const p = Object.fromEntries(f.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    const hh = Number(p.hour) === 24 ? 0 : Number(p.hour);
    if (+p.year === y && +p.month === m && +p.day === d && hh === h && +p.minute === mi) out.push(t);
  }
  return out.length ? Math.min(...out) : null;
}
const cases = [
  ["Europe/London", 2026, 3, 29, 1, 30, "gap"], ["Europe/London", 2026, 10, 25, 1, 30, "fold"],
  ["America/New_York", 2026, 3, 8, 2, 30, "gap"], ["America/New_York", 2026, 11, 1, 1, 30, "fold"],
  ["Europe/Berlin", 2026, 10, 25, 2, 30, "fold"],
  ["Australia/Sydney", 2026, 4, 5, 2, 30, "fold"], ["Australia/Sydney", 2026, 4, 5, 1, 30, "pre-fold valid"],
  ["Australia/Sydney", 2026, 10, 4, 2, 30, "gap"], ["Australia/Sydney", 2026, 10, 4, 1, 30, "pre-gap valid"],
  ["Pacific/Auckland", 2026, 4, 5, 2, 30, "fold"], ["Pacific/Auckland", 2026, 4, 5, 1, 30, "pre-fold valid"],
  ["Pacific/Auckland", 2026, 9, 27, 2, 30, "gap"], ["Pacific/Auckland", 2026, 9, 27, 1, 30, "pre-gap valid"],
  ["Australia/Lord_Howe", 2026, 4, 5, 1, 45, "fold(30m)"],
];
let bad = 0;
for (const [tz, y, m, d, h, mi, label] of cases) {
  const got = zonedLocalInstant(tz, y, m, d, h, mi); const exp = brute(tz, y, m, d, h, mi);
  const okv = got === exp; if (!okv) bad++;
  console.log(JSON.stringify({ tz, local: `${y}-${m}-${d} ${h}:${mi}`, label, got: got && new Date(got).toISOString(), expectedFirst: exp && new Date(exp).toISOString(), ok: okv }));
}
// Scheduler-level: daily 01:30 Sydney across fold day must produce an occurrence on 2026-04-05
const r = dailyInstantsInRange({ timeZone: "Australia/Sydney", localTime: "01:30", afterMs: Date.UTC(2026, 3, 3), toMs: Date.UTC(2026, 3, 6) });
console.log("sydney daily 01:30 Apr3..Apr6:", r.map((x) => new Date(x).toISOString()));
console.log("MISMATCHES", bad);
