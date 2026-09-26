import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("CI workflow grants only read access to repository contents", () => {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const workflow = readFileSync(join(testDir, "../../../.github/workflows/ci.yml"), "utf8");
  assert.match(workflow, /^permissions:\s*\n\s+contents:\s*read\s*$/m);
});
