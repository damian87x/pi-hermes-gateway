import { join } from "node:path"; import { appendFileSync } from "node:fs";
import { openGateway, TestClock } from "/tmp/s1r1-clone/packages/gateway/dist/index.js";
import { createFakeAdapter } from "/tmp/s1r1-clone/packages/gateway/dist/fake-adapter.js";
const [dir, mode, phase] = process.argv.slice(2);
const ROUTE = { profileId: "p", adapterId: "fake", accountId: "a", chatId: "c" };
const clock = new TestClock(Date.UTC(2026, 0, 1, 10) + (phase === "restart" ? 5000 : 0));
const adapter = createFakeAdapter(); const orig = adapter.send;
adapter.send = (env) => {
  if (phase === "first" && mode === "mid-send") process.kill(process.pid, "SIGKILL");
  const r = orig(env); appendFileSync(join(dir, "sink.log"), env.deliveryId + "\n");
  if (phase === "first" && mode === "before-receipt") process.kill(process.pid, "SIGKILL");
  return r;
};
const { gateway: gw } = openGateway({ dbPath: join(dir, "g.sqlite"), clock, routes: [ROUTE], adapter });
if (phase === "first") {
  if (mode === "claim") { const o = gw.dispatchOne; }
  const r = { protocolVersion: 1, requestId: "r1", method: "delivery.enqueue", body: { route: ROUTE, text: "x", notAfter: clock.nowMs() + 3600e3 }, expiresAt: clock.nowMs() + 30000 };
  gw.handleRequest(r, 200); console.log("not killed"); gw.close();
} else {
  gw.tick(); gw.processOutbox();
  console.log(JSON.stringify({ deliveries: gw.store.listDeliveries().map((d) => [d.status, d.dispatch_intent]), audit: gw.store.listAudit().map((a) => a.kind) }));
  gw.close();
}
