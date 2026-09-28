import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "wiki-"));
}

export function writeNote(root: string, name: string, body: string): void {
  mkdirSync(join(root, "notes"), { recursive: true });
  writeFileSync(join(root, "notes", name), body, "utf8");
}
