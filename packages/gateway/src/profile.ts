import { chmodSync, mkdirSync, statSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

export function ensureProfileDir(profileDir: string): void {
  if (!existsSync(profileDir)) {
    mkdirSync(profileDir, { recursive: true, mode: 0o700 });
    chmodSync(profileDir, 0o700);
  }
  const st = statSync(profileDir);
  const uid = process.getuid();
  if (st.uid !== uid) throw new Error("profile directory owner mismatch");
  if ((st.mode & 0o777) !== 0o700) throw new Error("profile directory mode must be 0700");
}

export function assertSocketMode(socketPath: string): void {
  const st = statSync(socketPath);
  const uid = process.getuid();
  if (st.uid !== uid) throw new Error("socket owner mismatch");
  if ((st.mode & 0o777) !== 0o600) throw new Error("socket mode must be 0600");
}

export function profilePaths(profileDir: string): { lockPath: string; dbPath: string; socketPath: string } {
  return {
    lockPath: join(profileDir, "profile.lock"),
    dbPath: join(profileDir, "gateway.sqlite"),
    socketPath: join(profileDir, "gateway.sock"),
  };
}

export function unlinkOwnedSocket(socketPath: string): void {
  if (existsSync(socketPath)) unlinkSync(socketPath);
}
