// Test-only preload for dist/cli.js: points the trusted "report" registry entry at a
// controlled fake executable, so CLI tests never run the real report worker.
import { readdirSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";

const [executablePath, ...args] = JSON.parse(process.env.CLI_WORKER_TEST_PROFILE ?? "null");
const trustedPath = JSON.stringify("/usr/local/libexec/pi-hermes-gateway/report-worker");

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (!url.endsWith("/dist/worker/profiles.js")) return result;
    const source = String(result.source);
    if (!source.includes(trustedPath) || !source.includes("args: []")) throw new Error("report profile fixture not found");
    return {
      ...result,
      source: source.replace(trustedPath, JSON.stringify(executablePath)).replace("args: []", `args: ${JSON.stringify(args)}`),
    };
  },
});

// Optional start barrier: hold every CLI process until all have loaded, so admissions overlap.
if (process.env.CLI_WORKER_TEST_BARRIER) {
  const { dir, count } = JSON.parse(process.env.CLI_WORKER_TEST_BARRIER);
  writeFileSync(join(dir, `ready-${process.pid}`), "");
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 5000;
  while (readdirSync(dir).length < count) {
    if (Date.now() > deadline) throw new Error("CLI start barrier timed out");
    Atomics.wait(sleeper, 0, 0, 5);
  }
}
