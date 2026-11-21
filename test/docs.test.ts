import { beforeEach, describe, expect, it } from "vitest";
import { buildMatch, findLibrary, ftsTerms, indexBatch, removeLibrary, resolveLibraries, searchDocs, type IndexChunk } from "../src/docs";
import { fakeD1 } from "./d1-sqlite";

const chunk = (seq: number, doc_path: string, section_title: string, content: string, tokens = 50): IndexChunk => ({
  seq,
  doc_path,
  doc_title: doc_path.split("/").pop()!.replace(/\.md$/, ""),
  section_title,
  content,
  tokens,
});

const NEXT = [
  chunk(1, "docs/routing/middleware.md", "Middleware", "Middleware runs before a request is completed. Use it to redirect unauthenticated users."),
  chunk(2, "docs/routing/middleware.md", "Matcher", "The matcher config limits which paths the middleware runs on."),
  chunk(3, "docs/data/fetching.md", "Caching", "fetch requests are cached by default in server components."),
  chunk(4, "docs/data/fetching.md", "Revalidation", "Use revalidate to refresh cached data after a number of seconds."),
];

const HONO = [chunk(1, "docs/guides/middleware.md", "Middleware", "Hono middleware wraps handlers. app.use registers middleware for every route.")];

let db: ReturnType<typeof fakeD1>;

async function load(name: string, version: string, chunks: IndexChunk[], source: string, final = true) {
  return indexBatch(db, { library: { name, version, description: `${name} docs`, source }, chunks, reset: true, final }, `2026-11-21T00:00:0${version.length % 10}Z`);
}

beforeEach(async () => {
  db = fakeD1();
  await load("next", "16.2.9", NEXT.slice(0, 2), "https://github.com/vercel/next.js");
  await load("next", "16.4.6", NEXT, "https://github.com/vercel/next.js");
  await load("hono", "latest", HONO, "https://github.com/honojs/hono");
});

describe("terms and match expressions", () => {
  it("drops stopwords but keeps a stopword-only question searchable", () => {
    expect(ftsTerms("How do I use middleware in Next.js?")).toEqual(["middleware", "next", "js"]);
    expect(ftsTerms("how to")).toEqual(["how", "to"]);
  });

  it("quotes every term so FTS syntax in a question cannot break the query", () => {
    expect(buildMatch(7, ["a\"b", "or"], "or")).toBe('lib:"L7" AND ("a""b" OR "or")');
  });
});

describe("finding a library", () => {
  it("takes an exact name@version, the newest version for a bare name, or a Context7-style path", async () => {
    expect((await findLibrary(db, "next@16.2.9"))?.version).toBe("16.2.9");
    expect((await findLibrary(db, "next"))?.version).toBe("16.4.6");
    expect((await findLibrary(db, "/vercel/next.js"))?.version).toBe("16.4.6");
    expect(await findLibrary(db, "react")).toBeNull();
  });

  it("hides a library until its last batch arrives", async () => {
    await load("draft", "1.0.0", HONO, "https://example.com/draft", false);
    expect(await findLibrary(db, "draft")).toBeNull();
    await indexBatch(db, { library: { name: "draft", version: "1.0.0" }, chunks: [], final: true });
    expect((await findLibrary(db, "draft"))?.chunks).toBe(1);
  });

  it("lists closest names first with every version, newest first", async () => {
    const groups = await resolveLibraries(db, "next");
    expect(groups[0]!.name).toBe("next");
    expect(groups[0]!.versions.map((v) => v.version)).toEqual(["16.4.6", "16.2.9"]);
    expect((await resolveLibraries(db, "next.js")).map((g) => g.name)).toEqual(["next"]);
  });
});

describe("searching docs", () => {
  it("answers from the asked library only", async () => {
    const lib = (await findLibrary(db, "next@16.4.6"))!;
    const sections = await searchDocs(db, lib, "middleware");
    expect(sections[0]!.source).toBe("docs/routing/middleware.md");
    expect(sections.map((s) => s.content).join(" ")).not.toContain("Hono");
  });

  it("falls back to any-term matching when no section has every term", async () => {
    const lib = (await findLibrary(db, "next@16.4.6"))!;
    const sections = await searchDocs(db, lib, "configure middleware redirect zebra");
    expect(sections.length).toBeGreaterThan(0);
    expect(sections[0]!.content).toContain("redirect");
  });

  it("ranks a section that covers most of the question above a short one that repeats one word", async () => {
    // Fresh database: other libraries would change term weights and hide the ranking difference.
    db = fakeD1();
    await load(
      "nx",
      "1.0.0",
      [
        // Short and dense in two common words: plain BM25 puts this first.
        chunk(1, "docs/adapters.md", "beforeMiddleware", "middleware redirect middleware redirect middleware redirect."),
        // Long, but answers three of the four terms.
        chunk(
          5,
          "docs/guides/redirecting.md",
          "Proxy",
          `Use NextResponse.redirect in a proxy to send unauthenticated users to the login page. ${"The proxy runs on the server before the route renders and can rewrite or continue the request. ".repeat(12)}`,
          400,
        ),
      ],
      "https://example.com/nx",
    );
    const lib = (await findLibrary(db, "nx"))!;
    const sections = await searchDocs(db, lib, "middleware redirect unauthenticated users");
    expect(sections[0]!.source).toBe("docs/guides/redirecting.md");
  });

  it("merges neighbouring sections of one document in document order", async () => {
    const lib = (await findLibrary(db, "next@16.4.6"))!;
    // Both sections say "middleware runs", so both rank and are merged into one block.
    const sections = await searchDocs(db, lib, "middleware runs");
    const merged = sections.find((s) => s.title.includes("Middleware / Matcher"));
    expect(merged?.content.indexOf("Middleware runs")).toBeLessThan(merged!.content.indexOf("The matcher"));
  });

  it("keeps to the token budget but never returns nothing when one section is too big", async () => {
    await load("big", "1.0.0", [chunk(1, "docs/a.md", "Huge", "middleware ".repeat(50), 9000)], "https://example.com/big");
    const lib = (await findLibrary(db, "big"))!;
    const sections = await searchDocs(db, lib, "middleware", 1000);
    expect(sections).toHaveLength(1);
  });

  it("re-indexing replaces the old chunks, and removing a library removes it from search", async () => {
    await load("hono", "latest", [chunk(1, "docs/new.md", "Routing", "Routing only now.")], "https://github.com/honojs/hono");
    const hono = (await findLibrary(db, "hono"))!;
    expect(hono.chunks).toBe(1);
    expect(await searchDocs(db, hono, "middleware")).toEqual([]);

    expect(await removeLibrary(db, "hono", "latest")).toBe(true);
    expect(await findLibrary(db, "hono")).toBeNull();
    const ftsRows = db.raw.prepare("SELECT count(*) AS n FROM chunks_fts WHERE chunks_fts MATCH 'routing'").get() as { n: number };
    expect(ftsRows.n).toBe(0);
  });
});
