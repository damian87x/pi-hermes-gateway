import { mkdtempSync, rmSync, unlinkSync, writeFileSync, existsSync, chmodSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path"; import { spawn } from "node:child_process";
const DIST = process.argv[2];
const { acquireProfileLock } = await import(`${DIST}/index.js`);
const ROUTE = { profileId: "profile-a", adapterId: "fake", accountId: "acct-1", chatId: "chat-1" };
const out = {};
const dir = mkdtempSync(join(tmpdir(), "r3cs-p4-")); chmodSync(dir, 0o700);
writeFileSync(join(dir, "config.json"), JSON.stringify({ routes: [ROUTE] }), { mode: 0o600 });
const env = { ...process.env, PATH: "/nonexistent" }; // no python3 reachable
const cli = join(DIST, "cli.js");
const a = spawn(process.execPath, [cli, "--profile", dir], { env, stdio: ["ignore", "pipe", "pipe"] });
await new Promise((res) => a.stderr.on("data", (c) => { if (String(c).includes("listening")) res(); }));
out.firstStartedWithoutPython = true;
const b = spawn(process.execPath, [cli, "--profile", dir], { env, stdio: ["ignore", "pipe", "pipe"] });
let berr = ""; b.stderr.on("data", (c) => (berr += c)); const bcode = await new Promise((r) => b.once("exit", (c) => r(c)));
out.secondInstance = { exitCode: bcode, stderr: berr.trim(), firstSocketStillPresent: existsSync(join(dir, "gateway.sock")) };
unlinkSync(join(dir, "profile.lock")); // same-UID actor removes lock file while holder alive
let split; try { const h = acquireProfileLock(join(dir, "profile.lock")); split = "acquired while first daemon alive (split-brain)"; h.release(); } catch (e) { split = `refused: ${e.message}`; }
out.afterLockFileUnlink = split;
a.kill("SIGKILL"); await new Promise((r) => a.once("exit", r));
let after; try { acquireProfileLock(join(dir, "profile.lock")).release(); after = "acquired"; } catch (e) { after = e.message; }
out.afterHolderSigkill = after;
rmSync(dir, { recursive: true, force: true });
console.log(JSON.stringify(out, null, 1));
