import { beforeEach, describe, expect, it } from "vitest";
import { embedInput, findLibrary, indexBatch, removeLibrary, searchDocs, wellFormed, withRateLimitRetry, type IndexChunk, type Semantic } from "../src/docs";
import { fakeD1 } from "./d1-sqlite";

/**
 * Stand-ins for Workers AI and Vectorize. The fake embedding maps words to a few
 * concepts, so "unauthenticated" and "login" land near each other the way a real
 * embedding model puts them, while keyword search sees different words.
 */
const CONCEPTS: Record<string, number> = {
  middleware: 0, proxy: 0,
  redirect: 1, redirects: 1, redirecting: 1,
  unauthenticated: 2, authenticated: 2, authenticate: 2, login: 2, session: 2,
  cache: 3, cached: 3, caching: 3,
};

function fakeAi() {
  const calls: string[][] = [];
  const ai = {
    run: async (_model: string, input: { text: string[] }) => {
      calls.push(input.text);
      return {
        data: input.text.map((t) => {
          const v = [0, 0, 0, 0];
          for (const w of t.toLowerCase().match(/[a-z]+/g) ?? []) if (w in CONCEPTS) v[CONCEPTS[w]!]! += 1;
          return v;
        }),
      };
    },
  };
  return { ai: ai as unknown as Ai, calls };
}

function fakeVectorize() {
  const store = new Map<string, { values: number[]; namespace?: string }>();
  const stats = { deleteCalls: 0, rateLimitNextUpserts: 0 };
  const cos = (a: number[], b: number[]) => {
    const dot = a.reduce((s, x, i) => s + x * b[i]!, 0);
    const n = Math.hypot(...a) * Math.hypot(...b);
    return n ? dot / n : 0;
  };
  const vectors = {
    // Same per-call limits the real Vectorize enforces.
    upsert: async (vs: { id: string; values: number[]; namespace?: string }[]) => {
      if (vs.length > 1000) throw new Error("upsert: max 1000 vectors");
      if (stats.rateLimitNextUpserts > 0) {
        stats.rateLimitNextUpserts--;
        throw new Error("VECTOR_UPSERT_ERROR (code = 40041): Too Many Requests");
      }
      for (const v of vs) store.set(v.id, { values: v.values, namespace: v.namespace });
      return { mutationId: "m" };
    },
    deleteByIds: async (ids: string[]) => {
      stats.deleteCalls++;
      if (ids.length > 100) throw new Error("VECTOR_DELETE_ERROR (code = 40007): too many ids in payload; max id count is 100");
      for (const id of ids) store.delete(id);
      return { mutationId: "m" };
    },
    query: async (q: number[], opts: { topK: number; namespace?: string }) => ({
      matches: [...store.entries()]
        .filter(([, v]) => !opts.namespace || v.namespace === opts.namespace)
        .map(([id, v]) => ({ id, score: cos(q, v.values) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, opts.topK),
      count: 0,
    }),
  };
  return { vectors: vectors as unknown as VectorizeIndex, store, stats };
}

const chunk = (seq: number, doc_path: string, section_title: string, content: string): IndexChunk => ({
  seq,
  doc_path,
  doc_title: doc_path,
  section_title,
  content,
  tokens: 60,
});

const KEYWORD_BAIT = chunk(1, "adapters.md", "beforeMiddleware", "middleware redirect middleware redirect middleware redirect.");
const ANSWER = chunk(
  9,
  "guides/redirecting.md",
  "NextResponse.redirect in Proxy",
  "The proxy runs before a request completes. If the user is not authenticated, send them to the login page with NextResponse.redirect.",
);
const QUESTION = "middleware redirect unauthenticated users";

let db: ReturnType<typeof fakeD1>;
let semantic: Semantic;
let store: Map<string, { values: number[]; namespace?: string }>;
let stats: { deleteCalls: number; rateLimitNextUpserts: number };

beforeEach(async () => {
  db = fakeD1();
  const v = fakeVectorize();
  store = v.store;
  stats = v.stats;
  semantic = { ai: fakeAi().ai, vectors: v.vectors };
  await indexBatch(db, { library: { name: "next", version: "16.4.6" }, chunks: [KEYWORD_BAIT, ANSWER], reset: true, final: true }, undefined, semantic);
});

describe("meaning search", () => {
  it("finds the answering section that keyword search ranks below a word-repeating one", async () => {
    const lib = (await findLibrary(db, "next"))!;
    const keywordOnly = await searchDocs(db, lib, QUESTION);
    expect(keywordOnly[0]!.source).toBe("adapters.md");

    const hybrid = await searchDocs(db, lib, QUESTION, undefined, semantic);
    expect(hybrid[0]!.source).toBe("guides/redirecting.md");
  });

  it("stores one vector per chunk under the library's namespace", async () => {
    const lib = (await findLibrary(db, "next"))!;
    const ids = (db.raw.prepare("SELECT id FROM chunks WHERE library_id = ? ORDER BY id").all(lib.id) as { id: number }[]).map((r) => String(r.id));
    expect([...store.keys()].sort()).toEqual(ids.sort());
    expect([...store.values()].every((v) => v.namespace === `L${lib.id}`)).toBe(true);
  });

  it("never returns another library's sections", async () => {
    await indexBatch(
      db,
      { library: { name: "other", version: "1.0.0" }, chunks: [chunk(1, "auth.md", "Login redirect", "redirect unauthenticated users to login with a proxy session")], reset: true, final: true },
      undefined,
      semantic,
    );
    const lib = (await findLibrary(db, "next"))!;
    const hybrid = await searchDocs(db, lib, QUESTION, undefined, semantic);
    expect(hybrid.map((s) => s.source)).not.toContain("auth.md");
  });

  it("deletes more than 100 old vectors within Vectorize's per-call limit", async () => {
    const many = Array.from({ length: 150 }, (_, i) => chunk(i + 1, `p${i}.md`, "Proxy", "proxy redirect login"));
    await indexBatch(db, { library: { name: "big", version: "1.0.0" }, chunks: many, reset: true, final: true }, undefined, semantic);
    expect(store.size).toBe(152);
    await indexBatch(db, { library: { name: "big", version: "1.0.0" }, chunks: [], reset: true, final: true }, undefined, semantic);
    expect(store.size).toBe(2);
  });

  it("never sends half an emoji to the embedding model", () => {
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    // 1,999 letters, then an emoji whose first half is character 2,000: a plain slice keeps only that half.
    const cutInEmoji = embedInput({ doc_title: "d", section_title: "s", content: "x".repeat(2000 - "d > s\n".length - 1) + "😀 tail" });
    expect(lone.test(cutInEmoji)).toBe(false);
    expect(wellFormed("a\uD800b")).toBe("a�b");
    expect(wellFormed("ok 😀")).toBe("ok 😀");
  });

  it("retries a rate-limited Vectorize call and gives up on other errors at once", async () => {
    const waits: number[] = [];
    let calls = 0;
    const ok = await withRateLimitRetry(async () => {
      if (++calls < 3) throw new Error("VECTOR_UPSERT_ERROR (code = 40041): Too Many Requests");
      return "done";
    }, 6, async (ms) => void waits.push(ms));
    expect(ok).toBe("done");
    expect(waits).toEqual([300, 600]);
    await expect(withRateLimitRetry(async () => { throw new Error("VECTOR_DELETE_ERROR (code = 40007)"); }, 6, async () => {})).rejects.toThrow("40007");
  });

  it("finishes indexing when Vectorize rate-limits an upsert once", async () => {
    stats.rateLimitNextUpserts = 1;
    await indexBatch(db, { library: { name: "rl", version: "1.0.0" }, chunks: [ANSWER], reset: true, final: true }, undefined, semantic);
    expect((await findLibrary(db, "rl"))?.vectors).toBe(1);
  });

  it("re-sending a middle batch replaces its sections instead of duplicating them", async () => {
    const lib = { name: "resend", version: "1.0.0" };
    await indexBatch(db, { library: lib, chunks: [chunk(1, "a.md", "A", "proxy one"), chunk(2, "a.md", "B", "proxy two")], reset: true }, undefined, semantic);
    const middle = { library: lib, chunks: [chunk(3, "b.md", "C", "redirect three"), chunk(4, "b.md", "D", "login four")] };
    await indexBatch(db, middle, undefined, semantic);
    await indexBatch(db, middle, undefined, semantic); // the client retried
    await indexBatch(db, { library: lib, chunks: [], final: true }, undefined, semantic);
    const found = (await findLibrary(db, "resend"))!;
    expect(found.chunks).toBe(4);
    expect([...store.values()].filter((v) => v.namespace === `L${found.id}`)).toHaveLength(4);
  });

  it("skips vector deletes for a library that never had vectors", async () => {
    await indexBatch(db, { library: { name: "plain", version: "1.0.0" }, chunks: [ANSWER], reset: true, final: true }); // keyword only
    const before = stats.deleteCalls;
    await indexBatch(db, { library: { name: "plain", version: "1.0.0" }, chunks: [ANSWER], reset: true, final: true }, undefined, semantic);
    expect(stats.deleteCalls).toBe(before);
  });

  it("ignores a leftover vector that points at another library's section", async () => {
    await indexBatch(
      db,
      { library: { name: "other", version: "1.0.0" }, chunks: [chunk(1, "secret.md", "Login", "redirect unauthenticated users to login with a proxy")], reset: true, final: true },
      undefined,
      semantic,
    );
    const next = (await findLibrary(db, "next"))!;
    const otherChunk = db.raw.prepare("SELECT c.id FROM chunks c JOIN libraries l ON l.id = c.library_id WHERE l.name = 'other'").get() as { id: number };
    store.set(String(otherChunk.id), { values: [1, 1, 1, 0], namespace: `L${next.id}` }); // stale vector in next's namespace
    const hybrid = await searchDocs(db, next, QUESTION, undefined, semantic);
    expect(hybrid.map((s) => s.source)).not.toContain("secret.md");
  });

  it("drops a library's old vectors when it is re-indexed or removed", async () => {
    await indexBatch(db, { library: { name: "next", version: "16.4.6" }, chunks: [ANSWER], reset: true, final: true }, undefined, semantic);
    expect(store.size).toBe(1);
    expect(await removeLibrary(db, "next", "16.4.6", semantic)).toBe(true);
    expect(store.size).toBe(0);
  });
});
