import { createHash, timingSafeEqual } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const LIST_LIMIT = 100;
export const TEXT_LIMIT = 256;
export const DEFAULT_ALLOWED_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "[::1]"]);
const TOKEN_FILE = "dashboard.token";
// At least 256 bits as hex (64 chars) or base64url (43 chars).
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,}$/;

const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>pi-hermes-gateway dashboard</title>
<body>
<h1>pi-hermes-gateway dashboard</h1>
<p>Read-only local view of gateway jobs. GET-only. No send.</p>
<p><label>Owner token <input id="token" type="password" autocomplete="off"></label>
<button id="load" type="button">Load</button></p>
<pre id="status">enter the token from the profile dashboard.token file</pre>
<script>
document.getElementById("load").addEventListener("click", function () {
  var input = document.getElementById("token");
  var token = input.value.trim();
  input.value = "";
  fetch("/api/status", { headers: { Authorization: "Bearer " + token }, cache: "no-store" })
    .then(function (r) { return r.text(); })
    .then(function (t) { document.getElementById("status").textContent = t; });
});
</script>
</body>
`;

export type JobView = {
  jobId: string;
  kind: string;
  status: string;
  createdAtMs: number;
  text: string;
};

export type OccurrenceView = {
  occurrenceId: string;
  jobId: string;
  scheduledInstantMs: number;
  status: string;
};

export type DeliveryView = {
  deliveryId: string;
  jobId: string | null;
  occurrenceId: string | null;
  source: string;
  status: string;
  createdAtMs: number;
  text: string;
};

export type DashboardStatus = {
  jobs: JobView[];
  occurrences: OccurrenceView[];
  deliveries: DeliveryView[];
  jobsTotal: number;
  occurrencesTotal: number;
  deliveriesTotal: number;
  truncated: { jobs: boolean; occurrences: boolean; deliveries: boolean };
};

export type DashboardOptions = {
  profileDir: string;
  bind?: string;
  port?: number;
  allowedHosts?: ReadonlySet<string>;
  collect?: (dbPath: string) => unknown;
};

export type Dashboard = {
  listen(): Promise<{ port: number; host: string }>;
  close(): Promise<void>;
};

function clip(value: string): string {
  return value.length <= TEXT_LIMIT ? value : value.slice(0, TEXT_LIMIT);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function countRows(db: DatabaseSync, table: "jobs" | "occurrences" | "deliveries"): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
  return asNumber(row?.n ?? 0);
}

export function collectStatus(dbPath: string): DashboardStatus {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const jobsTotal = countRows(db, "jobs");
    const occurrencesTotal = countRows(db, "occurrences");
    const deliveriesTotal = countRows(db, "deliveries");
    const jobs = db
      .prepare(
        "SELECT job_id, kind, status, created_at_ms, text FROM jobs ORDER BY created_at_ms DESC LIMIT ?",
      )
      .all(LIST_LIMIT)
      .map((row) => ({
        jobId: asString(row.job_id),
        kind: asString(row.kind),
        status: asString(row.status),
        createdAtMs: asNumber(row.created_at_ms),
        text: clip(asString(row.text)),
      }));
    const occurrences = db
      .prepare(
        "SELECT occurrence_id, job_id, scheduled_instant_ms, status FROM occurrences ORDER BY scheduled_instant_ms DESC LIMIT ?",
      )
      .all(LIST_LIMIT)
      .map((row) => ({
        occurrenceId: asString(row.occurrence_id),
        jobId: asString(row.job_id),
        scheduledInstantMs: asNumber(row.scheduled_instant_ms),
        status: asString(row.status),
      }));
    const deliveries = db
      .prepare(
        "SELECT delivery_id, job_id, occurrence_id, source, status, created_at_ms, text FROM deliveries ORDER BY created_at_ms DESC LIMIT ?",
      )
      .all(LIST_LIMIT)
      .map((row) => ({
        deliveryId: asString(row.delivery_id),
        jobId: asNullableString(row.job_id),
        occurrenceId: asNullableString(row.occurrence_id),
        source: asString(row.source),
        status: asString(row.status),
        createdAtMs: asNumber(row.created_at_ms),
        text: clip(asString(row.text)),
      }));
    return {
      jobs,
      occurrences,
      deliveries,
      jobsTotal,
      occurrencesTotal,
      deliveriesTotal,
      truncated: {
        jobs: jobsTotal > LIST_LIMIT,
        occurrences: occurrencesTotal > LIST_LIMIT,
        deliveries: deliveriesTotal > LIST_LIMIT,
      },
    };
  } finally {
    db.close();
  }
}

export function hostName(hostHeader: string): string {
  const host = hostHeader.trim().toLowerCase();
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    if (end === -1) return host;
    return host.slice(0, end + 1);
  }
  const colon = host.lastIndexOf(":");
  if (colon !== -1 && host.indexOf(":") === colon) {
    return host.slice(0, colon);
  }
  return host;
}

function isLoopbackBind(bind: string): boolean {
  if (bind === "::1") return true;
  const parts = bind.split(".");
  return (
    parts.length === 4 &&
    parts[0] === "127" &&
    parts.every((p) => /^(0|[1-9][0-9]{0,2})$/.test(p) && Number(p) <= 255)
  );
}

function digest(value: string): Uint8Array {
  return createHash("sha256").update(value).digest();
}

// Owner-provisioned capability: a regular 0600 file owned by this uid inside the profile dir.
function readOwnerToken(profileDir: string): Uint8Array {
  const path = join(profileDir, TOKEN_FILE);
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Error(`${TOKEN_FILE} missing in profile directory`);
  }
  if (!stat.isFile()) throw new Error(`${TOKEN_FILE} must be a regular file, not a symlink`);
  if (stat.uid !== process.getuid()) throw new Error(`${TOKEN_FILE} must be owned by the current user`);
  if ((stat.mode & 0o077) !== 0) throw new Error(`${TOKEN_FILE} must not be group/other accessible (chmod 600)`);
  const token = readFileSync(path, "utf8").trim();
  if (!TOKEN_PATTERN.test(token)) {
    throw new Error(`${TOKEN_FILE} must hold at least 43 base64url or 64 hex characters`);
  }
  return digest(token);
}

function bearerMatches(header: string | undefined, expected: Uint8Array): boolean {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  return timingSafeEqual(digest(header.slice("Bearer ".length)), expected);
}

function write(res: ServerResponse, code: number, type: string, body: string): void {
  const bytes = new TextEncoder().encode(body);
  res.statusCode = code;
  res.setHeader("Content-Type", type);
  res.setHeader("Content-Length", bytes.byteLength);
  if (type.includes("application/json")) {
    res.setHeader("Cache-Control", "no-store");
  }
  res.end(bytes);
}

function reject(res: ServerResponse, code: number, message: string): void {
  write(res, code, "text/plain; charset=utf-8", message);
}

export function createDashboard(options: DashboardOptions): Dashboard {
  const bind = options.bind ?? "127.0.0.1";
  if (!isLoopbackBind(bind)) {
    throw new Error("dashboard bind must be a numeric loopback address (127.x.x.x or ::1)");
  }
  const port = options.port ?? 0;
  const allowed = new Set(options.allowedHosts ?? DEFAULT_ALLOWED_HOSTS);
  allowed.add(bind === "::1" ? "[::1]" : bind);
  const ownerToken = readOwnerToken(options.profileDir);
  const dbPath = join(options.profileDir, "gateway.sqlite");
  const collect = options.collect ?? collectStatus;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const rawHost = req.headers.host;
    const hostHeader = typeof rawHost === "string" ? rawHost : "";
    if (!allowed.has(hostName(hostHeader))) {
      reject(res, 403, "forbidden\n");
      return;
    }
    const method = req.method ?? "";
    if (method !== "GET") {
      reject(res, 405, "method not allowed\n");
      return;
    }
    const path = req.url ?? "";
    if (path === "/") {
      write(res, 200, "text/html; charset=utf-8", PAGE);
      return;
    }
    if (path === "/api/status") {
      if (!bearerMatches(req.headers.authorization, ownerToken)) {
        reject(res, 401, "unauthorized\n");
        return;
      }
      try {
        write(res, 200, "application/json; charset=utf-8", JSON.stringify(collect(dbPath)));
      } catch (err) {
        const name = err instanceof Error ? err.constructor.name : "Error";
        write(
          res,
          503,
          "application/json; charset=utf-8",
          JSON.stringify({ error: `status collection failed: ${name}` }),
        );
      }
      return;
    }
    reject(res, 404, "not found\n");
  });

  return {
    listen() {
      return new Promise((resolve, rejectListen) => {
        const onError = (err: unknown) => {
          rejectListen(err instanceof Error ? err : new Error("listen failed"));
        };
        server.once("error", onError);
        server.listen(port, bind, () => {
          server.off("error", onError);
          const addr = server.address();
          if (!addr || typeof addr === "string") {
            rejectListen(new Error("listen failed"));
            return;
          }
          resolve({ port: addr.port, host: bind });
        });
      });
    },
    close() {
      return new Promise((resolve, rejectClose) => {
        server.close((err) => {
          if (err) rejectClose(err);
          else resolve();
        });
      });
    },
  };
}
