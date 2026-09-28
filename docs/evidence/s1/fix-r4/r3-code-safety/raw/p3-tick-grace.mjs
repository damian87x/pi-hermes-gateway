const DIST = process.argv[2];
const { openGateway, TestClock, DEFAULT_CONFIG, DEFAULT_TICK_INTERVAL_MS } = await import(`${DIST}/index.js`);
const { PROTOCOL_VERSION } = await import("pi-hermes-gateway-protocol");
import { mkdtempSync, rmSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
const ROUTE = { profileId: "profile-a", adapterId: "fake", accountId: "acct-1", chatId: "chat-1" };
const out = { DEFAULT_TICK_INTERVAL_MS, tickGraceMs: DEFAULT_CONFIG.tickGraceMs, catchUpPolicy: DEFAULT_CONFIG.catchUpPolicy };
// deterministic: continuously running daemon with default config, tick lateness delta
for (const delta of [0, 1, 2, 5]) {
  const dir = mkdtempSync(join(tmpdir(), "r3cs-p3-"));
  const S = Date.UTC(2026, 0, 1, 12);
  const clock = new TestClock(S - 1); // tick 1 ms before the slot
  const { gateway: gw, } = openGateway({ dbPath: join(dir, "g.sqlite"), clock, routes: [ROUTE] });
  const req = { protocolVersion: PROTOCOL_VERSION, requestId: `p3-${delta}`, method: "job.create", expiresAt: clock.nowMs() + 30000,
    body: { kind: "static-text", text: "noon", route: ROUTE, schedule: { type: "daily", localTime: "12:00", timeZone: "UTC" } } };
  gw.handleRequest(req, 500);
  gw.tick();
  clock.add(DEFAULT_TICK_INTERVAL_MS + delta); gw.tick();
  out[`lateness_${delta}ms`] = { sent: gw.adapter.sent.length, occ: gw.store.listOccurrences().map(o => o.status) };
  gw.close(); rmSync(dir, { recursive: true, force: true });
}
// real Node setInterval lateness (scaled interval 250ms, 12 ticks)
const gaps = []; let last = Date.now();
await new Promise((res) => { let n = 0; const t = setInterval(() => { const now = Date.now(); gaps.push(now - last); last = now; if (++n >= 12) { clearInterval(t); res(); } }, 250); });
out.realSetInterval250Gaps = gaps; out.maxLatenessMs = Math.max(...gaps) - 250; out.ticksLate = gaps.filter(g => g > 250).length;
console.log(JSON.stringify(out, null, 1));
