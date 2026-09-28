import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type WikiCompileOptions = {
  rootDir: string;
};

export type WikiArticle = {
  id: string;
  title: string;
  source: string;
  body: string;
  concepts: string[];
};

export type WikiConcept = {
  id: string;
  title: string;
  articles: string[];
};

export type WikiCompileResult = {
  articles: WikiArticle[];
  concepts: WikiConcept[];
};

function cmp(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function nfc(value: string): string {
  return value.normalize("NFC");
}

function slug(value: string): string {
  const trimmed = nfc(value).trim().replace(/[\\/:\0]+/g, "-").replace(/^\.+/, "").replace(/\.+$/, "");
  if (trimmed === "" || trimmed === "index") return "_index";
  return trimmed;
}

function titleOf(raw: string, fallback: string): string {
  for (const line of raw.split(/\r?\n/)) {
    const match = /^#\s+(.+)$/.exec(line.trim());
    if (match?.[1]) return nfc(match[1].trim());
  }
  return nfc(fallback);
}

function extractConcepts(raw: string): string[] {
  const found: string[] = [];
  const re = /\[\[([^\[\]]+)\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw))) {
    const inner = match[1] ?? "";
    const target = nfc((inner.split("|")[0] ?? "").trim());
    if (target) found.push(target);
  }
  return found;
}

function uniqueSorted(items: string[]): string[] {
  return [...new Set(items)].sort(cmp);
}

function renderIndex(heading: string, items: string[]): string {
  if (items.length === 0) return `# ${heading}\n`;
  return [`# ${heading}`, "", ...items].join("\n") + "\n";
}

function renderArticle(article: WikiArticle): string {
  const concepts = article.concepts.length === 0 ? "Concepts:" : `Concepts: ${article.concepts.map((c) => `[[${c}]]`).join(" ")}`;
  const body = article.body.endsWith("\n") ? article.body : `${article.body}\n`;
  return `# ${article.title}\n\nSource: ${article.source}\n\n${concepts}\n\n${body}`;
}

function renderConcept(concept: WikiConcept, titles: Map<string, string>): string {
  const items = concept.articles.map((id) => `- [${titles.get(id) ?? id}](../articles/${id}.md)`);
  return `# ${concept.title}\n\n## Articles\n\n${items.join("\n")}\n`;
}

export function compileWiki(options: WikiCompileOptions): WikiCompileResult {
  const notesDir = join(options.rootDir, "notes");
  const articlesDir = join(options.rootDir, "wiki", "articles");
  const conceptsDir = join(options.rootDir, "wiki", "concepts");

  rmSync(articlesDir, { recursive: true, force: true });
  rmSync(conceptsDir, { recursive: true, force: true });
  mkdirSync(articlesDir, { recursive: true });
  mkdirSync(conceptsDir, { recursive: true });

  const names = existsSync(notesDir)
    ? readdirSync(notesDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && !entry.name.startsWith("."))
        .map((entry) => entry.name)
        .sort(cmp)
    : [];

  const articles: WikiArticle[] = [];
  const conceptMap = new Map<string, { title: string; articles: Set<string> }>();

  for (const name of names) {
    const raw = readFileSync(join(notesDir, name), "utf8");
    const stem = name.slice(0, -3);
    const id = slug(stem);
    const title = titleOf(raw, stem);
    const concepts = uniqueSorted(extractConcepts(raw));
    for (const conceptTitle of concepts) {
      const conceptId = slug(conceptTitle);
      let record = conceptMap.get(conceptId);
      if (!record) {
        record = { title: nfc(conceptTitle.trim()), articles: new Set() };
        conceptMap.set(conceptId, record);
      }
      record.articles.add(id);
    }
    articles.push({ id, title, source: `notes/${name}`, body: raw, concepts });
  }

  articles.sort((a, b) => cmp(a.id, b.id));
  const titles = new Map(articles.map((article) => [article.id, article.title]));
  const concepts: WikiConcept[] = [...conceptMap.entries()]
    .map(([id, record]) => ({
      id,
      title: record.title,
      articles: [...record.articles].sort(cmp),
    }))
    .sort((a, b) => cmp(a.id, b.id));

  for (const article of articles) {
    writeFileSync(join(articlesDir, `${article.id}.md`), renderArticle(article), "utf8");
  }
  writeFileSync(
    join(articlesDir, "index.md"),
    renderIndex(
      "Articles",
      articles.map((article) => `- [${article.title}](${article.id}.md)`),
    ),
    "utf8",
  );

  for (const concept of concepts) {
    writeFileSync(join(conceptsDir, `${concept.id}.md`), renderConcept(concept, titles), "utf8");
  }
  writeFileSync(
    join(conceptsDir, "index.md"),
    renderIndex(
      "Concepts",
      concepts.map((concept) => `- [${concept.title}](${concept.id}.md)`),
    ),
    "utf8",
  );

  return { articles, concepts };
}
