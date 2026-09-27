import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmodSync, chownSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createDashboard } from "../dist/index.js";
import { makeProfile } from "./helpers.ts";

function src(): string {
  return readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "index.ts"), "utf8");
}

function pkgJson(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
  ) as Record<string, unknown>;
}

const TOKEN = randomBytes(32).toString("hex");
const AUTH = { Authorization: `Bearer ${TOKEN}` };

function writeToken(dir: string, token = TOKEN, mode = 0o600): string {
  const file = join(dir, "dashboard.token");
  writeFileSync(file, `${token}\n`, { mode });
  chmodSync(file, mode);
  return file;
}

async function start(opts: Parameters<typeof createDashboard>[0]) {
  writeToken(opts.profileDir);
  const dash = createDashboard({ bind: "127.0.0.1", port: 0, ...opts });
  const { port } = await dash.listen();
  return { dash, port, url: `http://127.0.0.1:${port}` };
}

function raw(
  port: number,
  path: string,
  headers: Record<string, string>,
  method = "GET",
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: "127.0.0.1", port, path, method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test("GET / and GET /api/status serve a temp profile DB", async () => {
  const { dir } = makeProfile({ jobs: 1, occurrences: 1, deliveries: 1 });
  const { dash, url } = await start({ profileDir: dir });
  try {
    const index = await fetch(`${url}/`);
    assert.equal(index.status, 200);
    const html = await index.text();
    assert.match(html, /read-only/i);
    const statusRes = await fetch(`${url}/api/status`, { headers: AUTH });
    assert.equal(statusRes.status, 200);
    assert.equal(statusRes.headers.get("cache-control"), "no-store");
    const body = (await statusRes.json()) as { jobs: unknown[] };
    assert.equal(Array.isArray(body.jobs), true);
    assert.equal(body.jobs.length, 1);
  } finally {
    await dash.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unexpected Host is 403; localhost with port is allowed", async () => {
  const { dir } = makeProfile();
  const { dash, port, url } = await start({ profileDir: dir });
  try {
    const evil = await raw(port, "/", { Host: "evil.example.com" });
    assert.equal(evil.status, 403);
    const meta = await raw(port, "/api/status", { Host: "169.254.169.254" });
    assert.equal(meta.status, 403);
    const ok = await raw(port, "/api/status", { Host: `localhost:${port}`, ...AUTH });
    assert.equal(ok.status, 200);
  } finally {
    await dash.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("configured bind host is accepted and others stay forbidden", async () => {
  const { dir } = makeProfile();
  const { dash, port, url } = await start({
    profileDir: dir,
    allowedHosts: new Set(["127.0.0.1", "localhost", "[::1]", "192.168.68.55"]),
  });
  try {
    const allowed = await raw(port, "/", { Host: `192.168.68.55:${port}` });
    assert.equal(allowed.status, 200);
    const blocked = await raw(port, "/", { Host: "evil.example.com" });
    assert.equal(blocked.status, 403);
  } finally {
    await dash.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mutating HTTP methods are 405 and do not enqueue", async () => {
  const { dir } = makeProfile();
  const { dash, url } = await start({ profileDir: dir });
  try {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = await fetch(`${url}/api/status`, {
        method,
        headers: AUTH,
        body: method === "DELETE" ? undefined : "{}",
      });
      assert.equal(res.status, 405, method);
    }
    const approve = await fetch(`${url}/approve`, { method: "POST", body: "{}" });
    assert.equal(approve.status, 405);
    const apiApprove = await fetch(`${url}/api/approve`, { method: "POST", body: "{}" });
    assert.equal(apiApprove.status, 405);
  } finally {
    await dash.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unknown paths and traversal are 404", async () => {
  const { dir } = makeProfile();
  const { dash, port } = await start({ profileDir: dir });
  try {
    for (const path of ["/etc/passwd", "/api", "/api/status/extra", "/../index.ts", "/api/status?x=../../"]) {
      const res = await raw(port, path, { Host: "127.0.0.1", ...AUTH });
      assert.equal(res.status, 404, path);
    }
  } finally {
    await dash.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collection failure is 503 without leaking the error", async () => {
  const { dir } = makeProfile();
  const { dash, url } = await start({
    profileDir: dir,
    collect: () => {
      throw new Error("private value");
    },
  });
  try {
    const res = await fetch(`${url}/api/status`, { headers: AUTH });
    assert.equal(res.status, 503);
    const text = await res.text();
    assert.equal(text.includes("private value"), false);
    const body = JSON.parse(text) as { error: string };
    assert.match(body.error, /status collection failed/);
  } finally {
    await dash.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing profile DB is 503", async () => {
  const { dir } = makeProfile({ jobs: 0, occurrences: 0, deliveries: 0 });
  rmSync(join(dir, "gateway.sqlite"), { force: true });
  const { dash, url } = await start({ profileDir: dir });
  try {
    const res = await fetch(`${url}/api/status`, { headers: AUTH });
    assert.equal(res.status, 503);
  } finally {
    await dash.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("package is private npm plugin, not a Pi package; source has no enqueue", () => {
  const pkg = pkgJson();
  assert.equal(pkg.private, true);
  assert.equal(pkg.pi, undefined);
  const keywords = pkg.keywords;
  assert.equal(Array.isArray(keywords) && (keywords as string[]).includes("pi-package"), false);
  const text = src();
  assert.equal(text.includes("enqueue"), false);
  assert.equal(text.includes("chat.postMessage"), false);
  assert.equal(text.includes("sendMessage"), false);
});

function countingCollect() {
  const calls = { n: 0 };
  return {
    calls,
    collect: () => {
      calls.n += 1;
      return { jobs: [{ text: "secret-job-text" }], deliveries: [{ text: "secret-delivery-text" }] };
    },
  };
}

test("/api/status without or with a wrong bearer token is 401 and does not collect", async () => {
  const { dir } = makeProfile();
  const { calls, collect } = countingCollect();
  const { dash, port } = await start({ profileDir: dir, collect });
  try {
    const wrong = randomBytes(32).toString("hex");
    const attempts: Record<string, string>[] = [
      {},
      { Authorization: "" },
      { Authorization: `Bearer ${wrong}` },
      { Authorization: `Bearer ${TOKEN.slice(0, -1)}` },
      { Authorization: `Bearer ${TOKEN}x` },
      { Authorization: TOKEN },
      { Authorization: `Basic ${Buffer.from(`owner:${TOKEN}`).toString("base64")}` },
    ];
    for (const headers of attempts) {
      const res = await raw(port, "/api/status", { Host: "127.0.0.1", ...headers });
      assert.equal(res.status, 401, JSON.stringify(headers));
      assert.equal(res.body.includes("secret-"), false);
      assert.equal(res.body.includes(TOKEN), false);
    }
    const query = await raw(port, `/api/status?token=${TOKEN}`, { Host: "127.0.0.1" });
    assert.notEqual(query.status, 200);
    assert.equal(calls.n, 0);
  } finally {
    await dash.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("/api/status with the owner token returns job and delivery text", async () => {
  const { dir } = makeProfile({ jobs: 1, occurrences: 1, deliveries: 1 });
  const { dash, port } = await start({ profileDir: dir });
  try {
    const res = await raw(port, "/api/status", { Host: "127.0.0.1", ...AUTH });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body) as { jobs: { text: string }[]; deliveries: { text: string }[] };
    assert.equal(body.jobs[0]?.text, "hello-0");
    assert.equal(body.deliveries[0]?.text, "payload-0");
  } finally {
    await dash.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("forged Host is 403 even with the owner token, and never collects", async () => {
  const { dir } = makeProfile();
  const { calls, collect } = countingCollect();
  const { dash, port } = await start({ profileDir: dir, collect });
  try {
    for (const host of ["evil.example.com", "0.0.0.0", "192.168.68.55", "localhost.evil.example.com"]) {
      const res = await raw(port, "/api/status", { Host: host, ...AUTH });
      assert.equal(res.status, 403, host);
      assert.equal(res.body.includes("secret-"), false);
    }
    const noHost = await new Promise<string>((resolve, reject) => {
      const sock = connect(port, "127.0.0.1", () => {
        sock.end(`GET /api/status HTTP/1.0\r\nAuthorization: Bearer ${TOKEN}\r\n\r\n`);
      });
      const chunks: Buffer[] = [];
      sock.on("data", (c: Buffer) => chunks.push(c));
      sock.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      sock.on("error", reject);
    });
    assert.match(noHost, /^HTTP\/1\.[01] 403 /);
    assert.equal(noHost.includes("secret-"), false);
    const localNoToken = await raw(port, "/api/status", { Host: `localhost:${port}` });
    assert.equal(localNoToken.status, 401);
    assert.equal(calls.n, 0);
  } finally {
    await dash.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("non-loopback or hostname bind is rejected before listening", () => {
  const { dir } = makeProfile();
  writeToken(dir);
  try {
    for (const bind of [
      "0.0.0.0",
      "::",
      "192.168.68.55",
      "10.0.0.1",
      "localhost",
      "example.com",
      "127.0.0.256",
      "127.1",
      "0x7f.0.0.1",
      "::ffff:127.0.0.1",
      " 127.0.0.1",
      "",
    ]) {
      assert.throws(() => createDashboard({ profileDir: dir, bind, port: 0 }), /bind/, bind);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("numeric loopback binds 127.0.0.0/8 and ::1 listen", async () => {
  const { dir } = makeProfile();
  writeToken(dir);
  try {
    for (const bind of ["127.0.0.1", "::1"]) {
      const dash = createDashboard({ profileDir: dir, bind, port: 0 });
      const { port, host } = await dash.listen();
      assert.equal(host, bind);
      const hostHeader = bind === "::1" ? `[::1]:${port}` : `127.0.0.1:${port}`;
      const res = await new Promise<number>((resolve, reject) => {
        const req = httpRequest(
          { hostname: bind, port, path: "/api/status", headers: { Host: hostHeader, ...AUTH } },
          (r) => {
            r.resume();
            resolve(r.statusCode ?? 0);
          },
        );
        req.on("error", reject);
        req.end();
      });
      assert.equal(res, 200, bind);
      await dash.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing, symlinked, group/other-readable or weak token file fails closed", () => {
  const { dir } = makeProfile();
  const file = join(dir, "dashboard.token");
  try {
    assert.throws(() => createDashboard({ profileDir: dir }), /dashboard\.token/);

    const target = join(dir, "real.token");
    writeFileSync(target, `${TOKEN}\n`, { mode: 0o600 });
    symlinkSync(target, file);
    assert.throws(() => createDashboard({ profileDir: dir }), /dashboard\.token/);
    rmSync(file);

    for (const mode of [0o640, 0o604, 0o644]) {
      writeToken(dir, TOKEN, mode);
      assert.throws(() => createDashboard({ profileDir: dir }), /dashboard\.token/, mode.toString(8));
    }
    for (const weak of ["", "short", "a".repeat(42), `${TOKEN.slice(0, 40)} ${TOKEN.slice(40)}`, `${TOKEN}!`]) {
      writeToken(dir, weak);
      let message = "";
      try {
        createDashboard({ profileDir: dir });
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      assert.match(message, /dashboard\.token/, weak);
      if (weak.length > 0) assert.equal(message.includes(weak), false);
    }
    writeToken(dir);
    assert.doesNotThrow(() => createDashboard({ profileDir: dir }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("token file owned by another uid fails closed", (t) => {
  if (process.getuid?.() !== 0) {
    t.skip("chown to another uid needs root");
    return;
  }
  const { dir } = makeProfile();
  try {
    const file = writeToken(dir);
    chownSync(file, 65534, 65534);
    assert.throws(() => createDashboard({ profileDir: dir }), /dashboard\.token/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("page and error responses never contain the token; page keeps it in memory only", async () => {
  const { dir } = makeProfile();
  const { dash, port } = await start({
    profileDir: dir,
    collect: () => {
      throw new Error(TOKEN);
    },
  });
  try {
    const page = await raw(port, "/", { Host: "127.0.0.1", ...AUTH });
    assert.equal(page.status, 200);
    assert.equal(page.body.includes(TOKEN), false);
    assert.match(page.body, /type="password"/);
    assert.match(page.body, /Authorization/);
    assert.equal(/localStorage|sessionStorage|document\.cookie|location\.|<form/i.test(page.body), false);
    const responses = [
      await raw(port, "/api/status", { Host: "127.0.0.1", ...AUTH }),
      await raw(port, "/api/status", { Host: "evil.example.com", ...AUTH }),
      await raw(port, "/api/status", { Host: "127.0.0.1", ...AUTH }, "POST"),
      await raw(port, "/nope", { Host: "127.0.0.1", ...AUTH }),
    ];
    assert.deepEqual(
      responses.map((r) => r.status),
      [503, 403, 405, 404],
    );
    for (const r of responses) assert.equal(r.body.includes(TOKEN), false);
    assert.equal(src().includes("console."), false);
  } finally {
    await dash.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
