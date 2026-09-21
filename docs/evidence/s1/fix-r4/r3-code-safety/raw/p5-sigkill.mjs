// Real SIGKILL at mid-send/before-receipt and at claim, in a child process; parent reopens and checks recovery.
import { spawnSync } from "node:child_process"; import { mkdtempSync, rmSync, readFileSync, existsSync, chmodSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
const DIST = process.argv[2];
const { startDaemon, TestClock } = await import(`${DIST}/index.js`);
const ROUTE = { profileId: "profile-a", adapterId: "fake", accountId: "acct-1", chatId: "chat-1" };
const res = {};
for (const point of ["after-send-before-receipt", "claim"]) {
  const dir = mkdtempSync(join(tmpdir(), "r3cs-p5-")); chmodSync(dir, 0o700);
  const sink = join(dir, "sink.log");
  const child = `
    import { startDaemon, TestClock } from ${JSON.stringify(DIST + "/index.js")};
    import { PROTOCOL_VERSION } from "pi-hermes-gateway-protocol";
    import { appendFileSync } from "node:fs";
    const ROUTE = ${JSON.stringify(ROUTE)};
    const S = Date.UTC(2026,0,1,12);
    const clock = new TestClock(S - 30_000);
    const d = startDaemon({ profileDir: ${JSON.stringify(dir)}, routes: [ROUTE], clock, bindSocket: false, catchUpPolicy: "one-latest" });
    d.gateway.handleRequest({ protocolVersion: PROTOCOL_VERSION, requestId: "c1", method: "job.create", expiresAt: clock.nowMs()+30000,
      body: { kind: "static-text", text: "noon", route: ROUTE, schedule: { type: "daily", localTime: "12:00", timeZone: "UTC" } } }, 500);
    const origSend = d.adapter.send.bind(d.adapter);
    d.adapter.send = (env) => { const r = origSend(env); appendFileSync(${JSON.stringify(sink)}, env.text + "\\n"); ${point === "after-send-before-receipt" ? 'process.kill(process.pid, "SIGKILL");' : ""} return r; };
    ${point === "claim" ? `const st = d.gateway.store; const o = st.setOccurrenceStatus.bind(st); st.setOccurrenceStatus = (id, s) => { o(id, s); if (s === "claimed") process.kill(process.pid, "SIGKILL"); };` : ""}
    clock.set(S + 1_000); d.gateway.tick();
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", child], { cwd: process.argv[3], encoding: "utf8" });
  const sendsBefore = existsSync(sink) ? readFileSync(sink, "utf8").trim().split("\n").filter(Boolean).length : 0;
  const clock = new TestClock(Date.UTC(2026, 0, 1, 12, 0, 20));
  const d = startDaemon({ profileDir: dir, routes: [ROUTE], clock, bindSocket: false, catchUpPolicy: "one-latest" });
  const statusOnOpen = d.gateway.store.listDeliveries().map(x => x.status);
  d.gateway.tick(); clock.add(120_000); d.gateway.tick();
  const recoverAudit = d.gateway.store.listAudit().filter(a => a.kind === "crash.recover").length;
  res[point] = { childSignal: r.signal, childStderr: r.stderr.slice(0, 200), sendsBeforeKill: sendsBefore, statusOnReopen: statusOnOpen,
    sendsAfterReopen: d.adapter.sent.length, finalDeliveries: d.gateway.store.listDeliveries().map(x => x.status), crashRecoverAudit: recoverAudit,
    totalSends: sendsBefore + d.adapter.sent.length };
  d.stop(); rmSync(dir, { recursive: true, force: true });
}
console.log(JSON.stringify(res, null, 1));
