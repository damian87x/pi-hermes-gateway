import { existsSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { profilePaths } from "./profile.js";

export type DoctorCheckId = "node-path" | "node-sqlite" | "profile-dirs" | "linger";

export type DoctorCheck = {
  id: DoctorCheckId;
  ok: boolean;
  severity: "error" | "warn" | "info";
  message: string;
};

export type DoctorReport = {
  ok: boolean;
  lingerEnabled: boolean;
  logoutSurvivalClaim: boolean;
  checks: DoctorCheck[];
};

export type DoctorOptions = {
  profileDir: string;
  nodePath?: string;
  lingerEnabled?: boolean;
  lingerDir?: string;
  lingerUser?: string;
  env?: Record<string, string | undefined>;
};

const PI_AGENT_NPM = "/.pi/agent/npm";

export function containsPiAgentNpm(path: string): boolean {
  const norm = path.replace(/\\/g, "/");
  return norm.includes(`${PI_AGENT_NPM}/`) || norm.endsWith(PI_AGENT_NPM) || norm.includes("~/.pi/agent/npm");
}

export function probeLingerEnabled(opts?: { user?: string; lingerDir?: string; env?: Record<string, string | undefined> }): boolean {
  const env = opts?.env ?? process.env;
  const user = opts?.user ?? env.USER ?? env.LOGNAME ?? "";
  if (!user) return false;
  const dir = opts?.lingerDir ?? "/var/lib/systemd/linger";
  return existsSync(join(dir, user));
}

function checkNodePath(nodePath: string): DoctorCheck {
  if (!isAbsolute(nodePath)) {
    return { id: "node-path", ok: false, severity: "error", message: "Node path must be absolute" };
  }
  if (containsPiAgentNpm(nodePath)) {
    return {
      id: "node-path",
      ok: false,
      severity: "error",
      message: "Node path must not be under the Pi agent npm prefix",
    };
  }
  if (!existsSync(nodePath)) {
    return { id: "node-path", ok: false, severity: "error", message: "Node path does not exist" };
  }
  return { id: "node-path", ok: true, severity: "info", message: `absolute Node path ${nodePath}` };
}

function checkSqlite(): DoctorCheck {
  try {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("CREATE TABLE t(x INTEGER); INSERT INTO t(x) VALUES (1);");
      const row = db.prepare("SELECT x FROM t").get();
      if (row?.x !== 1) throw new Error("sqlite probe mismatch");
    } finally {
      db.close();
    }
    const ver = process.versions.sqlite;
    if (!ver) {
      return { id: "node-sqlite", ok: false, severity: "error", message: "process.versions.sqlite is missing" };
    }
    return { id: "node-sqlite", ok: true, severity: "info", message: `node:sqlite ${ver}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { id: "node-sqlite", ok: false, severity: "error", message: `node:sqlite unavailable: ${message}` };
  }
}

function checkProfileDirs(profileDir: string): DoctorCheck {
  if (!profileDir) {
    return { id: "profile-dirs", ok: false, severity: "error", message: "profile directory is required" };
  }
  if (!existsSync(profileDir)) {
    return { id: "profile-dirs", ok: false, severity: "error", message: "profile directory missing" };
  }
  const st = statSync(profileDir);
  if (!st.isDirectory()) {
    return { id: "profile-dirs", ok: false, severity: "error", message: "profile path is not a directory" };
  }
  const uid = process.getuid();
  if (st.uid !== uid) {
    return { id: "profile-dirs", ok: false, severity: "error", message: "profile directory owner mismatch" };
  }
  if ((st.mode & 0o777) !== 0o700) {
    return { id: "profile-dirs", ok: false, severity: "error", message: "profile directory mode must be 0700" };
  }
  const paths = profilePaths(profileDir);
  if (!paths.lockPath.startsWith(profileDir) || !paths.socketPath.startsWith(profileDir)) {
    return { id: "profile-dirs", ok: false, severity: "error", message: "lock/socket paths escape profile directory" };
  }
  return {
    id: "profile-dirs",
    ok: true,
    severity: "info",
    message: `lock ${paths.lockPath}; socket ${paths.socketPath}`,
  };
}

function checkLinger(enabled: boolean): DoctorCheck {
  if (enabled) {
    return { id: "linger", ok: true, severity: "info", message: "user linger is enabled" };
  }
  return {
    id: "linger",
    ok: true,
    severity: "warn",
    message: "linger is not enabled; refuse logout-survival claim. doctor does not enable linger",
  };
}

export function runDoctor(opts: DoctorOptions): DoctorReport {
  const nodePath = opts.nodePath ?? process.execPath;
  const lingerEnabled =
    opts.lingerEnabled !== undefined
      ? opts.lingerEnabled
      : probeLingerEnabled({
          ...(opts.lingerUser ? { user: opts.lingerUser } : {}),
          ...(opts.lingerDir ? { lingerDir: opts.lingerDir } : {}),
          ...(opts.env ? { env: opts.env } : {}),
        });
  const checks: DoctorCheck[] = [
    checkNodePath(nodePath),
    checkSqlite(),
    checkProfileDirs(opts.profileDir),
    checkLinger(lingerEnabled),
  ];
  const hardOk = checks.every((c) => c.severity !== "error" || c.ok);
  return {
    ok: hardOk,
    lingerEnabled,
    logoutSurvivalClaim: hardOk && lingerEnabled,
    checks,
  };
}
