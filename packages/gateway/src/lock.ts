import { spawn } from "node:child_process";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import process from "node:process";

export type HeldLock = {
  release(): void;
};

const LOCKER = `
import fcntl, os, sys
path = sys.argv[1]
ready = path + ".ready." + str(os.getpid())
f = open(path, "a")
try:
    fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    sys.exit(2)
with open(ready, "w") as rf:
    rf.write("1")
try:
    sys.stdin.read()
finally:
    try:
        os.remove(ready)
    except OSError:
        pass
`;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function acquireProfileLock(lockPath: string): HeldLock {
  if (!existsSync(lockPath)) writeFileSync(lockPath, "", { mode: 0o600 });
  const child = spawn("python3", ["-c", LOCKER, lockPath], {
    stdio: ["pipe", "ignore", "ignore"],
  });
  const pid = child.pid;
  if (pid === undefined) {
    const err = new Error("profile lock held");
    (err as Error & { code: string }).code = "profile_locked";
    throw err;
  }
  const readyPath = `${lockPath}.ready.${pid}`;
  const start = Date.now();
  while (!existsSync(readyPath) && Date.now() - start < 2000) {
    if (!pidAlive(pid) && !existsSync(readyPath)) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  if (!existsSync(readyPath)) {
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    const err = new Error("profile lock held");
    (err as Error & { code: string }).code = "profile_locked";
    throw err;
  }
  return {
    release() {
      try {
        child.stdin?.end();
      } catch {
        /* ignore */
      }
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      if (existsSync(readyPath)) {
        try {
          unlinkSync(readyPath);
        } catch {
          /* ignore */
        }
      }
    },
  };
}
