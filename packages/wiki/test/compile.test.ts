import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { compileWiki } from "../dist/index.js";
import { makeRoot, writeNote } from "./helpers.ts";

test("empty notes yield empty article and concept indexes", () => {
  const root = makeRoot();
  try {
    mkdirSync(join(root, "notes"));
    const result = compileWiki({ rootDir: root });
    assert.deepEqual(result.articles, []);
    assert.deepEqual(result.concepts, []);
    assert.equal(readFileSync(join(root, "wiki/articles/index.md"), "utf8"), "# Articles\n");
    assert.equal(readFileSync(join(root, "wiki/concepts/index.md"), "utf8"), "# Concepts\n");
    assert.deepEqual(readdirSync(join(root, "wiki/articles")).sort(), ["index.md"]);
    assert.deepEqual(readdirSync(join(root, "wiki/concepts")).sort(), ["index.md"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing notes directory yields empty indexes", () => {
  const root = makeRoot();
  try {
    const result = compileWiki({ rootDir: root });
    assert.deepEqual(result.articles, []);
    assert.deepEqual(result.concepts, []);
    assert.equal(readFileSync(join(root, "wiki/articles/index.md"), "utf8"), "# Articles\n");
    assert.equal(readFileSync(join(root, "wiki/concepts/index.md"), "utf8"), "# Concepts\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compiles a note into an article using the H1 title", () => {
  const root = makeRoot();
  try {
    writeNote(root, "alpha.md", "# Alpha\n\nHello.\n");
    const result = compileWiki({ rootDir: root });
    assert.equal(result.articles.length, 1);
    assert.equal(result.articles[0]?.id, "alpha");
    assert.equal(result.articles[0]?.title, "Alpha");
    assert.equal(result.articles[0]?.source, "notes/alpha.md");
    const article = readFileSync(join(root, "wiki/articles/alpha.md"), "utf8");
    assert.match(article, /^# Alpha\n/);
    assert.match(article, /Source: notes\/alpha\.md/);
    assert.match(article, /Hello\./);
    assert.match(readFileSync(join(root, "wiki/articles/index.md"), "utf8"), /\[Alpha\]\(alpha\.md\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("extracts [[wikilinks]] into concept pages", () => {
  const root = makeRoot();
  try {
    writeNote(root, "note.md", "# Note\n\nSee [[Widget]] and [[Gadget]].\n");
    const result = compileWiki({ rootDir: root });
    assert.deepEqual(result.articles[0]?.concepts, ["Gadget", "Widget"]);
    assert.equal(result.concepts.length, 2);
    assert.equal(result.concepts[0]?.title, "Gadget");
    assert.deepEqual(result.concepts[0]?.articles, ["note"]);
    const gadget = readFileSync(join(root, "wiki/concepts/Gadget.md"), "utf8");
    assert.match(gadget, /^# Gadget\n/);
    assert.match(gadget, /\[Note\]\(\.\.\/articles\/note\.md\)/);
    assert.match(readFileSync(join(root, "wiki/concepts/index.md"), "utf8"), /\[Gadget\]\(Gadget\.md\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unicode titles and concepts are preserved", () => {
  const root = makeRoot();
  try {
    writeNote(root, "café.md", "# Café München\n\n[[日本語]] [[概念]]\n");
    const result = compileWiki({ rootDir: root });
    assert.equal(result.articles[0]?.id, "café");
    assert.equal(result.articles[0]?.title, "Café München");
    assert.deepEqual(result.articles[0]?.concepts, ["日本語", "概念"]);
    assert.ok(result.concepts.some((c) => c.title === "日本語"));
    assert.ok(result.concepts.some((c) => c.title === "概念"));
    assert.equal(readFileSync(join(root, "wiki/articles/café.md"), "utf8").slice(0, 14), "# Café München");
    assert.match(readFileSync(join(root, "wiki/concepts/日本語.md"), "utf8"), /Café München/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("NFC-normalizes equivalent unicode concept spellings", () => {
  const root = makeRoot();
  try {
    writeNote(root, "a.md", "# A\n\n[[caf\u00e9]]\n");
    writeNote(root, "b.md", "# B\n\n[[cafe\u0301]]\n");
    const result = compileWiki({ rootDir: root });
    assert.equal(result.concepts.length, 1);
    assert.equal(result.concepts[0]?.title, "café");
    assert.deepEqual(result.concepts[0]?.articles, ["a", "b"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compile is byte-identical across runs", () => {
  const root = makeRoot();
  try {
    writeNote(root, "zeta.md", "# Zeta\n\n[[Beta]] then [[Alpha]]\n");
    writeNote(root, "alpha.md", "# Alpha\n\n[[Beta]]\n");
    compileWiki({ rootDir: root });
    const first = snapshot(root);
    compileWiki({ rootDir: root });
    const second = snapshot(root);
    assert.deepEqual(second, first);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ignores non-markdown files and does not recurse", () => {
  const root = makeRoot();
  try {
    writeNote(root, "keep.md", "# Keep\n");
    writeFileSync(join(root, "notes", "skip.txt"), "# Nope\n[[Ghost]]\n");
    mkdirSync(join(root, "notes", "nested"));
    writeFileSync(join(root, "notes", "nested", "deep.md"), "# Deep\n[[Ghost]]\n");
    writeFileSync(join(root, "notes", ".hidden.md"), "# Hidden\n[[Ghost]]\n");
    const result = compileWiki({ rootDir: root });
    assert.equal(result.articles.length, 1);
    assert.equal(result.articles[0]?.id, "keep");
    assert.deepEqual(result.concepts, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("[[Target|label]] uses Target as the concept", () => {
  const root = makeRoot();
  try {
    writeNote(root, "note.md", "# Note\n\n[[Widget|a widget]]\n");
    const result = compileWiki({ rootDir: root });
    assert.deepEqual(result.articles[0]?.concepts, ["Widget"]);
    assert.equal(result.concepts[0]?.title, "Widget");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recompile removes stale article and concept files", () => {
  const root = makeRoot();
  try {
    writeNote(root, "old.md", "# Old\n\n[[Relic]]\n");
    compileWiki({ rootDir: root });
    rmSync(join(root, "notes", "old.md"));
    writeNote(root, "new.md", "# New\n");
    const result = compileWiki({ rootDir: root });
    assert.equal(result.articles[0]?.id, "new");
    assert.deepEqual(result.concepts, []);
    assert.deepEqual(readdirSync(join(root, "wiki/articles")).sort(), ["index.md", "new.md"]);
    assert.deepEqual(readdirSync(join(root, "wiki/concepts")).sort(), ["index.md"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("duplicate wikilinks on one note collapse; concept lists articles sorted", () => {
  const root = makeRoot();
  try {
    writeNote(root, "b.md", "# Bravo\n\n[[Shared]]\n");
    writeNote(root, "a.md", "# Alpha\n\n[[Shared]] [[Shared]]\n");
    const result = compileWiki({ rootDir: root });
    assert.deepEqual(result.articles[0]?.concepts, ["Shared"]);
    assert.deepEqual(result.concepts[0]?.articles, ["a", "b"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const dir of ["wiki/articles", "wiki/concepts"]) {
    for (const name of readdirSync(join(root, dir)).sort()) {
      out[`${dir}/${name}`] = readFileSync(join(root, dir, name), "utf8");
    }
  }
  return out;
}
