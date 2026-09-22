import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { profilePaths } from "./profile.js";

export type DoctorCheckId = "node-path" | "cli-path" | "node-sqlite" | "profile-dirs" | "linger" | "unit";

export type DoctorCheck = {
  id: DoctorCheckId;
  ok: boolean;
  severity: "error" | "warn" | "info";
  message: string;
};

export type DoctorReport = {
  ok: boolean;
  lingerEnabled: boolean;
  lingerPrecondition: boolean;
  unitEvidence: boolean;
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
  cliPath?: string;
  unitEvidence?: boolean;
  unitFile?: string;
};

const PI_AGENT_NPM = "/.pi/agent/npm";

export function containsPiAgentNpm(path: string): boolean {
  const norm = path.replace(/\\/g, "/");
  return norm.includes(`${PI_AGENT_NPM}/`) || norm.endsWith(PI_AGENT_NPM) || norm.includes("~/.pi/agent/npm");
}

function isPathInside(root: string, target: string): boolean {
  if (target === root) return true;
  const prefix = root.endsWith(sep) ? root : root + sep;
  return target.startsWith(prefix);
}

function underResolvedPiAgentNpm(path: string, env?: Record<string, string | undefined>): boolean {
  const home = env?.HOME ?? homedir();
  const prefixPath = join(home, ".pi", "agent", "npm");
  let prefixReal: string;
  try {
    prefixReal = realpathSync(prefixPath);
  } catch {
    return false;
  }
  let targetReal: string;
  try {
    targetReal = realpathSync(path);
  } catch {
    targetReal = resolve(path);
  }
  return isPathInside(prefixReal, targetReal);
}

function lingerUsername(opts?: { user?: string }): string {
  if (opts?.user !== undefined) return opts.user;
  try {
    return userInfo().username;
  } catch {
    return "";
  }
}

export function probeLingerEnabled(opts?: {
  user?: string;
  lingerDir?: string;
  env?: Record<string, string | undefined>;
}): boolean {
  const user = lingerUsername(opts?.user !== undefined ? { user: opts.user } : {});
  if (!user || user === "." || user === ".." || user.includes("/")) return false;
  const dir = opts?.lingerDir ?? "/var/lib/systemd/linger";
  return existsSync(join(dir, user));
}

export function probeUnitEvidence(opts?: { unitEvidence?: boolean; unitFile?: string }): boolean {
  if (opts?.unitEvidence === true) return true;
  if (opts?.unitFile) return existsSync(opts.unitFile);
  return false;
}

function inspectPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function checkNodePath(nodePath: string): DoctorCheck {
  if (!isAbsolute(nodePath)) {
    return { id: "node-path", ok: false, severity: "error", message: "Node path must be absolute" };
  }
  const inspected = inspectPath(nodePath);
  if (containsPiAgentNpm(nodePath) || containsPiAgentNpm(inspected)) {
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

function checkCliPath(cliPath: string, env?: Record<string, string | undefined>): DoctorCheck {
  const inspected = inspectPath(cliPath);
  if (
    containsPiAgentNpm(cliPath) ||
    containsPiAgentNpm(inspected) ||
    underResolvedPiAgentNpm(cliPath, env) ||
    underResolvedPiAgentNpm(inspected, env)
  ) {
    return {
      id: "cli-path",
      ok: false,
      severity: "error",
      message: "CLI must not be under the Pi agent npm prefix",
    };
  }
  return { id: "cli-path", ok: true, severity: "info", message: `CLI path ${inspected}` };
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
  const resolvedProfile = resolve(profileDir);
  const paths = profilePaths(profileDir);
  const lockResolved = resolve(paths.lockPath);
  const socketResolved = resolve(paths.socketPath);
  if (!lockResolved.startsWith(resolvedProfile) || !socketResolved.startsWith(resolvedProfile)) {
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

function checkUnit(evidence: boolean, lingerEnabled: boolean): DoctorCheck {
  if (evidence) {
    return { id: "unit", ok: true, severity: "info", message: "user unit evidence present" };
  }
  return {
    id: "unit",
    ok: true,
    severity: lingerEnabled ? "warn" : "info",
    message: "no user unit evidence; linger is a precondition only; doctor does not enable the unit",
  };
}

export function runDoctor(opts: DoctorOptions): DoctorReport {
  const nodePath = opts.nodePath ?? process.execPath;
  const lingerEnabled =
    opts.lingerEnabled !== undefined
      ? opts.lingerEnabled
      : probeLingerEnabled({
          ...(opts.lingerUser !== undefined ? { user: opts.lingerUser } : {}),
          ...(opts.lingerDir ? { lingerDir: opts.lingerDir } : {}),
          ...(opts.env ? { env: opts.env } : {}),
        });
  const unitEvidence = probeUnitEvidence({
    ...(opts.unitEvidence !== undefined ? { unitEvidence: opts.unitEvidence } : {}),
    ...(opts.unitFile ? { unitFile: opts.unitFile } : {}),
  });
  const checks: DoctorCheck[] = [
    checkNodePath(nodePath),
    checkSqlite(),
    checkProfileDirs(opts.profileDir),
    checkLinger(lingerEnabled),
    checkUnit(unitEvidence, lingerEnabled),
  ];
  if (opts.cliPath) checks.splice(1, 0, checkCliPath(opts.cliPath, opts.env));
  const hardOk = checks.every((c) => c.severity !== "error" || c.ok);
  const lingerPrecondition = lingerEnabled;
  return {
    ok: hardOk,
    lingerEnabled,
    lingerPrecondition,
    unitEvidence,
    logoutSurvivalClaim: hardOk && lingerPrecondition && unitEvidence,
    checks,
  };
}
