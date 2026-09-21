import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
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

async function start(opts: Parameters<typeof createDashboard>[0]) {
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
    const statusRes = await fetch(`${url}/api/status`);
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
    const ok = await raw(port, "/api/status", { Host: `localhost:${port}` });
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
      const res = await fetch(`${url}/api/status`, { method, body: method === "DELETE" ? undefined : "{}" });
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
      const res = await raw(port, path, { Host: "127.0.0.1" });
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
    const res = await fetch(`${url}/api/status`);
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
    const res = await fetch(`${url}/api/status`);
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
