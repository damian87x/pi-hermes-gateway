import { mkdtempSync, readdirSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path"; import { execFileSync } from "node:child_process";
import { acquireProfileLock, startDaemon } from "/tmp/s1r1-clone/packages/gateway/dist/index.js";
const out = {};
// Lock: acquire in this process, second acquire must fail; then kill the python locker child and retry
const dir = mkdtempSync(join(tmpdir(), "s1r1-lock-")); const lp = join(dir, "profile.lock");
const held = acquireProfileLock(lp);
try { acquireProfileLock(lp); out.secondWhileHeld = "ACQUIRED(bad)"; } catch (e) { out.secondWhileHeld = e.code; }
const pids = execFileSync("pgrep", ["-f", lp], { encoding: "utf8" }).trim().split("\n");
out.lockHolderProcesses = pids.map((p) => execFileSync("ps", ["-o", "pid=,comm=", "-p", p], { encoding: "utf8" }).trim());
for (const p of pids) process.kill(Number(p), "SIGKILL");
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
try { const h2 = acquireProfileLock(lp); out.secondAfterLockerChildKilled = "ACQUIRED while first holder process still alive and never released"; h2.release(); } catch (e) { out.secondAfterLockerChildKilled = e.code; }
out.staleReadyFiles = readdirSync(dir).filter((f) => f.includes(".ready."));
held.release();
// Daemon default clock: frozen? periodic tick?
const pd = mkdtempSync(join(tmpdir(), "s1r1-daemon-"));
const before = process.getActiveResourcesInfo();
const d = startDaemon({ profileDir: pd, routes: [{ profileId: "p", adapterId: "fake", accountId: "a", chatId: "c" }], bindSocket: false });
const t0 = d.gateway.clock.nowMs(); const w0 = Date.now();
await new Promise((r) => setTimeout(r, 1500));
out.daemonClock = { clockAdvancedMs: d.gateway.clock.nowMs() - t0, wallAdvancedMs: Date.now() - w0, clockCtor: d.gateway.clock.constructor.name };
out.activeResourcesAfterStart = process.getActiveResourcesInfo().filter((x) => !before.includes(x) || x === "Timeout");
d.stop();
console.log(JSON.stringify(out, null, 1));
