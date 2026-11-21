/**
 * Server-side docs search on D1 (FTS5), the part that makes this work like Context7:
 * an agent asks a question over MCP and gets the matching doc sections back,
 * with nothing installed on its machine.
 */

export interface Library {
  id: number;
  name: string;
  version: string;
  description: string | null;
  source: string | null;
  chunks: number;
  tokens: number;
  ready: number;
  /** 1 when the library's sections have vectors in Vectorize. */
  vectors: number;
  updated: string;
}

export interface Section {
  title: string;
  source: string;
  content: string;
  tokens: number;
}

interface ChunkHit {
  id: number;
  seq: number;
  doc_path: string;
  doc_title: string;
  section_title: string;
  content: string;
  tokens: number;
  score: number;
}

export const DEFAULT_TOKENS = 4000;
export const MAX_TOKENS = 20000;
const HITS = 30;
const WIDE_HITS = 100;
const RELEVANCE_DROP = 0.4;

const STOPWORDS = new Set(
  "a an and are as at be by can do does for from how i in is it of on or the to use using what when where which with you your my we this that should".split(" "),
);

/** Search terms from a natural-language question; stopwords go unless nothing else is left. */
export function ftsTerms(query: string): string[] {
  const words = query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  const kept = words.filter((w) => !STOPWORDS.has(w));
  return [...new Set(kept.length ? kept : words)].slice(0, 12);
}

const quote = (term: string) => `"${term.replace(/"/g, '""')}"`;

export function buildMatch(libraryId: number, terms: string[], mode: "and" | "or"): string {
  return `lib:${quote(`L${libraryId}`)} AND (${terms.map(quote).join(mode === "and" ? " AND " : " OR ")})`;
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

/** Newest first: semver by number, then labels such as `main` by update time. */
export function newestFirst(a: Library, b: Library): number {
  const sa = SEMVER.exec(a.version);
  const sb = SEMVER.exec(b.version);
  if (sa && sb) {
    for (let i = 1; i <= 3; i++) {
      const d = Number(sb[i]) - Number(sa[i]);
      if (d !== 0) return d;
    }
  } else if (sa || sb) {
    return sa ? -1 : 1;
  }
  return b.updated.localeCompare(a.updated);
}

const newest = (rows: Library[]) => rows.sort(newestFirst)[0] ?? null;

/**
 * Accepts `name@version`, a bare `name` (newest version), or a Context7-style
 * `/org/project` id, which is matched against the library's source URL.
 */
export async function findLibrary(db: D1Database, rawId: string): Promise<Library | null> {
  const id = rawId.trim();
  const at = id.lastIndexOf("@");
  if (at > 0) {
    const exact = await db
      .prepare("SELECT * FROM libraries WHERE ready = 1 AND name = ? AND version = ?")
      .bind(id.slice(0, at), id.slice(at + 1))
      .first<Library>();
    if (exact) return exact;
  }
  const name = at > 0 ? id.slice(0, at) : id;
  const byName = await db.prepare("SELECT * FROM libraries WHERE ready = 1 AND name = ?").bind(name).all<Library>();
  if (byName.results.length) return newest(byName.results);

  const path = name.replace(/^\/+/, "").toLowerCase();
  if (!path) return null;
  const bySource = await db
    .prepare("SELECT * FROM libraries WHERE ready = 1 AND (lower(source) LIKE ? OR lower(source) LIKE ?)")
    .bind(`%/${path}`, `%/${path}/%`)
    .all<Library>();
  return newest(bySource.results);
}

export interface LibraryGroup {
  name: string;
  versions: Library[];
}

/** Libraries whose name, description, or source contains the asked name; closest names first. */
export async function resolveLibraries(db: D1Database, asked: string, limit = 10): Promise<LibraryGroup[]> {
  const q = asked.trim().replace(/^\/+/, "").toLowerCase();
  if (!q) return [];
  const like = `%${q}%`;
  const rows = (
    await db
      .prepare(
        "SELECT * FROM libraries WHERE ready = 1 AND (lower(name) LIKE ? OR lower(coalesce(description, '')) LIKE ? OR lower(coalesce(source, '')) LIKE ?) LIMIT 300",
      )
      .bind(like, like, like)
      .all<Library>()
  ).results;

  const groups = new Map<string, Library[]>();
  for (const row of rows) groups.set(row.name, [...(groups.get(row.name) ?? []), row]);
  const rank = (name: string) => {
    const n = name.toLowerCase();
    if (n === q) return 0;
    if (n.startsWith(q)) return 1;
    if (n.includes(q)) return 2;
    return 3;
  };
  return [...groups.entries()]
    .map(([name, versions]) => ({ name, versions: versions.sort(newestFirst) }))
    .sort(
      (a, b) =>
        rank(a.name) - rank(b.name) ||
        Math.max(...b.versions.map((v) => v.chunks)) - Math.max(...a.versions.map((v) => v.chunks)) ||
        a.name.localeCompare(b.name),
    )
    .slice(0, limit);
}

/** Rough English stem so "users" finds "user" and "unauthenticated" finds "unauthenticate". */
export function stem(term: string): string {
  if (term.length <= 4 || !/^[a-z]+$/.test(term)) return term;
  return term.replace(/(ies|es|s|ed|ing|ly)$/, "") || term;
}

/** Share of the question's terms that appear in a section's titles or text. */
export function coverage(hit: Pick<ChunkHit, "doc_title" | "section_title" | "content">, terms: string[]): number {
  const text = `${hit.doc_title}\n${hit.section_title}\n${hit.content}`.toLowerCase();
  return terms.filter((t) => text.includes(stem(t))).length / terms.length;
}

/**
 * When no section has every term, rank by how many terms a section covers first and
 * BM25 second, so a section that answers most of the question beats a short one
 * that only repeats a common word.
 */
export function rankByCoverage<T extends ChunkHit>(found: T[], terms: string[]): T[] {
  const scored = found.map((h) => ({ h, c: coverage(h, terms) }));
  const best = Math.max(0, ...scored.map((s) => s.c));
  return scored
    .filter((s) => s.c >= best * 0.5)
    .sort((a, b) => b.c - a.c || b.h.score - a.h.score)
    .map((s) => s.h);
}

async function hits(db: D1Database, match: string, limit = HITS): Promise<ChunkHit[]> {
  return (
    await db
      .prepare(
        `SELECT c.id, c.seq, c.doc_path, c.doc_title, c.section_title, c.content, c.tokens,
                -bm25(chunks_fts, 0.0, 5.0, 10.0, 1.0) AS score
         FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid
         WHERE chunks_fts MATCH ?
         ORDER BY score DESC
         LIMIT ${Math.min(Math.max(1, Math.floor(limit)), WIDE_HITS)}`,
      )
      .bind(match)
      .all<ChunkHit>()
  ).results;
}

/** Keyword ranking: every term must match first; if that finds fewer than three sections, rank by term coverage. */
async function keywordHits(db: D1Database, library: Library, terms: string[]): Promise<ChunkHit[]> {
  if (terms.length === 0) return [];
  const all = await hits(db, buildMatch(library.id, terms, "and"));
  if (all.length < 3 && terms.length > 1) {
    return rankByCoverage(await hits(db, buildMatch(library.id, terms, "or"), WIDE_HITS), terms).slice(0, HITS);
  }
  const top = all[0]?.score ?? 0;
  return all.filter((h) => h.score >= top * RELEVANCE_DROP);
}

// ---------- meaning search (optional: Workers AI embeddings + Vectorize) ----------

export interface Semantic {
  ai: Ai;
  vectors: VectorizeIndex;
}

export const EMBED_MODEL = "@cf/baai/bge-m3"; // 1024 dimensions, multilingual
const EMBED_BATCH = 20;
const EMBED_CHARS = 2000;
const VECTOR_HITS = 30;
const RRF_K = 60;

export const namespaceOf = (libraryId: number) => `L${libraryId}`;
/**
 * Text sent to the embedding model. Cutting at a UTF-16 index can split an emoji and leave
 * half a surrogate pair, which Workers AI rejects (8006 "must be valid JSON"); drop that half
 * and replace any other lone surrogate with U+FFFD.
 */
export function wellFormed(text: string, maxChars = Number.POSITIVE_INFINITY): string {
  let s = text.length > maxChars ? text.slice(0, maxChars) : text;
  if (/[\uD800-\uDBFF]$/.test(s)) s = s.slice(0, -1);
  return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�");
}

export const embedInput = (c: { doc_title: string; section_title: string; content: string }) =>
  wellFormed(`${c.doc_title} > ${c.section_title}\n${c.content}`, EMBED_CHARS);

export async function embed(ai: Ai, texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const res = (await ai.run(EMBED_MODEL as Parameters<Ai["run"]>[0], { text: texts.slice(i, i + EMBED_BATCH) } as never)) as {
      data: number[][];
    };
    out.push(...res.data);
  }
  return out;
}

/**
 * Retries a Vectorize call that was rate-limited (code 40041, "Too Many Requests"),
 * waiting 0.3 s, 0.6 s, 1.2 s, … between tries. Other errors are thrown at once.
 */
export async function withRateLimitRetry<T>(run: () => Promise<T>, tries = 6, wait = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (attempt >= tries || !/40041|Too Many Requests/i.test(message)) throw err;
      await wait(300 * 2 ** (attempt - 1));
    }
  }
}

/** Sections by id, only from the given library: a stale vector can never surface another library's text. */
async function chunksById(db: D1Database, libraryId: number, ids: number[]): Promise<ChunkHit[]> {
  if (ids.length === 0) return [];
  const rows = (
    await db
      .prepare(
        `SELECT id, seq, doc_path, doc_title, section_title, content, tokens, 0 AS score FROM chunks
         WHERE library_id = ? AND id IN (${ids.map(() => "?").join(", ")})`,
      )
      .bind(libraryId, ...ids)
      .all<ChunkHit>()
  ).results;
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter((r): r is ChunkHit => !!r);
}

async function meaningHits(db: D1Database, library: Library, query: string, semantic: Semantic): Promise<ChunkHit[]> {
  if (library.vectors !== 1) return [];
  const [vector] = await embed(semantic.ai, [wellFormed(query, EMBED_CHARS)]);
  if (!vector) return [];
  const res = await semantic.vectors.query(vector, { topK: VECTOR_HITS, namespace: namespaceOf(library.id) });
  return chunksById(db, library.id, res.matches.map((m) => Number(m.id)).filter(Number.isInteger));
}

/**
 * Reciprocal rank fusion. The first list is the meaning list; on a tie the better
 * meaning rank wins, because it reads the question as a whole.
 */
export function fuse(lists: ChunkHit[][]): ChunkHit[] {
  const score = new Map<number, number>();
  const hit = new Map<number, ChunkHit>();
  lists.forEach((list) =>
    list.forEach((h, rank) => {
      score.set(h.id, (score.get(h.id) ?? 0) + 1 / (RRF_K + rank + 1));
      if (!hit.has(h.id)) hit.set(h.id, h);
    }),
  );
  const meaningRank = new Map((lists[0] ?? []).map((h, rank) => [h.id, rank]));
  const tieBreak = (id: number) => meaningRank.get(id) ?? Number.POSITIVE_INFINITY;
  return [...hit.values()].sort((a, b) => score.get(b.id)! - score.get(a.id)! || tieBreak(a.id) - tieBreak(b.id));
}

/**
 * Top sections for a question, within a token budget. With `semantic`, keyword and
 * meaning results are fused; without it, keyword ranking alone decides.
 */
export async function searchDocs(
  db: D1Database,
  library: Library,
  query: string,
  maxTokens = DEFAULT_TOKENS,
  semantic?: Semantic,
): Promise<Section[]> {
  const terms = ftsTerms(query);
  if (terms.length === 0) return [];
  // Both searches run at once; the meaning search waits on the embedding model, the keyword search on D1.
  const [keyword, meaning] = await Promise.all([
    keywordHits(db, library, terms),
    semantic ? meaningHits(db, library, query, semantic) : Promise.resolve([]),
  ]);
  const relevant = semantic ? fuse([meaning, keyword]).slice(0, HITS) : keyword;

  const budget = Math.min(Math.max(maxTokens, 500), MAX_TOKENS);
  const picked: ChunkHit[] = [];
  let used = 0;
  for (const hit of relevant) {
    if (used + hit.tokens > budget) {
      if (picked.length === 0) picked.push(hit); // one oversized section beats an empty answer
      break;
    }
    picked.push(hit);
    used += hit.tokens;
  }

  // Keep each document's sections together, in document order, merging neighbours.
  const docOrder = [...new Set(picked.map((h) => h.doc_path))];
  const sections: Section[] = [];
  for (const docPath of docOrder) {
    const inDoc = picked.filter((h) => h.doc_path === docPath).sort((a, b) => a.seq - b.seq);
    let current: Section & { last: number } | null = null;
    for (const h of inDoc) {
      if (current && h.seq === current.last + 1) {
        current.title += ` / ${h.section_title}`;
        current.content += `\n\n${h.content}`;
        current.tokens += h.tokens;
        current.last = h.seq;
        continue;
      }
      if (current) sections.push(current);
      current = { title: `${h.doc_title} > ${h.section_title}`, source: h.doc_path, content: h.content, tokens: h.tokens, last: h.seq };
    }
    if (current) sections.push(current);
  }
  return sections.map(({ title, source, content, tokens }) => ({ title, source, content, tokens }));
}

// ---------- indexing (publisher only) ----------

export interface IndexChunk {
  seq: number;
  doc_path: string;
  doc_title: string;
  section_title: string;
  content: string;
  tokens: number;
}

export interface IndexBatch {
  library: { name: string; version: string; description?: string; source?: string };
  chunks: IndexChunk[];
  reset?: boolean;
  final?: boolean;
}

export const MAX_BATCH_CHUNKS = 200;

export function validateBatch(body: unknown): IndexBatch {
  const b = body as IndexBatch;
  if (!b || typeof b !== "object" || !b.library || typeof b.library.name !== "string" || typeof b.library.version !== "string") {
    throw new Error("library.name and library.version are required");
  }
  if (!Array.isArray(b.chunks) || b.chunks.length > MAX_BATCH_CHUNKS) {
    throw new Error(`chunks must be an array of at most ${MAX_BATCH_CHUNKS}`);
  }
  for (const c of b.chunks) {
    if (
      !Number.isInteger(c.seq) ||
      !Number.isInteger(c.tokens) ||
      typeof c.doc_path !== "string" ||
      typeof c.doc_title !== "string" ||
      typeof c.section_title !== "string" ||
      typeof c.content !== "string"
    ) {
      throw new Error("each chunk needs integer seq and tokens and string doc_path, doc_title, section_title, content");
    }
  }
  return b;
}

/** Deletes the vectors of a library's chunks, optionally only chunks with seq in [from, to]. */
async function dropVectors(db: D1Database, libraryId: number, semantic: Semantic, range?: [number, number]) {
  const ids = (
    await (range
      ? db.prepare("SELECT id FROM chunks WHERE library_id = ? AND seq BETWEEN ? AND ?").bind(libraryId, range[0], range[1])
      : db.prepare("SELECT id FROM chunks WHERE library_id = ?").bind(libraryId)
    ).all<{ id: number }>()
  ).results.map((r) => String(r.id));
  // Vectorize rejects more than 100 ids per delete (VECTOR_DELETE_ERROR 40007), though upserts take 1,000.
  for (let i = 0; i < ids.length; i += 100) {
    const slice = ids.slice(i, i + 100);
    await withRateLimitRetry(() => semantic.vectors.deleteByIds(slice));
  }
}

/**
 * Index one batch. The first batch (`reset`) replaces any earlier copy and hides the
 * library from search; the last batch (`final`) counts the chunks and makes it searchable.
 * Re-sending a batch is safe: chunks in the batch's seq range are replaced, not duplicated.
 */
export async function indexBatch(db: D1Database, batch: IndexBatch, now = new Date().toISOString(), semantic?: Semantic) {
  const { name, version } = batch.library;
  let lib: { id: number; vectors: number } | null;
  if (batch.reset) {
    const before = await db.prepare("SELECT id, vectors FROM libraries WHERE name = ? AND version = ?").bind(name, version).first<{ id: number; vectors: number }>();
    if (before && semantic && before.vectors === 1) await dropVectors(db, before.id, semantic);
    lib = await db
      .prepare(
        `INSERT INTO libraries (name, version, description, source, ready, vectors, updated) VALUES (?, ?, ?, ?, 0, 0, ?)
         ON CONFLICT (name, version) DO UPDATE SET description = excluded.description, source = excluded.source,
           ready = 0, vectors = 0, chunks = 0, tokens = 0, updated = excluded.updated
         RETURNING id, vectors`,
      )
      .bind(name, version, batch.library.description ?? null, batch.library.source ?? null, now)
      .first<{ id: number; vectors: number }>();
    if (lib) await db.prepare("DELETE FROM chunks WHERE library_id = ?").bind(lib.id).run();
  } else {
    lib = await db.prepare("SELECT id, vectors FROM libraries WHERE name = ? AND version = ?").bind(name, version).first<{ id: number; vectors: number }>();
  }
  if (!lib) throw new Error("library not started: send the first batch with reset: true");

  if (batch.chunks.length) {
    // A retried batch must not leave two copies of the same sections.
    const seqs = batch.chunks.map((c) => c.seq);
    const range: [number, number] = [Math.min(...seqs), Math.max(...seqs)];
    if (!batch.reset) {
      if (semantic) await dropVectors(db, lib.id, semantic, range);
      await db.prepare("DELETE FROM chunks WHERE library_id = ? AND seq BETWEEN ? AND ?").bind(lib.id, range[0], range[1]).run();
    }
    const insert = db.prepare(
      "INSERT INTO chunks (library_id, lib, seq, doc_path, doc_title, section_title, content, tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const libId = lib.id;
    const results = await db.batch(
      batch.chunks.map((c) => insert.bind(libId, `L${libId}`, c.seq, c.doc_path, c.doc_title, c.section_title, c.content, c.tokens)),
    );
    if (semantic) {
      const values = await embed(semantic.ai, batch.chunks.map(embedInput));
      const vectors = results.map((r, i) => ({ id: String(r.meta.last_row_id), values: values[i]!, namespace: namespaceOf(libId) }));
      for (let i = 0; i < vectors.length; i += 1000) {
        const slice = vectors.slice(i, i + 1000);
        await withRateLimitRetry(() => semantic.vectors.upsert(slice));
      }
    }
  }

  if (batch.final) {
    await db
      .prepare(
        `UPDATE libraries SET ready = 1, vectors = ?, updated = ?,
           chunks = (SELECT count(*) FROM chunks WHERE library_id = ?),
           tokens = (SELECT coalesce(sum(tokens), 0) FROM chunks WHERE library_id = ?)
         WHERE id = ?`,
      )
      .bind(semantic ? 1 : 0, now, lib.id, lib.id, lib.id)
      .run();
  }
  return { libraryId: lib.id, inserted: batch.chunks.length, final: !!batch.final };
}

export async function removeLibrary(db: D1Database, name: string, version: string, semantic?: Semantic) {
  const lib = await db.prepare("SELECT id, vectors FROM libraries WHERE name = ? AND version = ?").bind(name, version).first<{ id: number; vectors: number }>();
  if (!lib) return false;
  if (semantic && lib.vectors === 1) await dropVectors(db, lib.id, semantic);
  await db.batch([
    db.prepare("DELETE FROM chunks WHERE library_id = ?").bind(lib.id),
    db.prepare("DELETE FROM libraries WHERE id = ?").bind(lib.id),
  ]);
  return true;
}

export async function listLibraries(db: D1Database): Promise<Library[]> {
  return (await db.prepare("SELECT * FROM libraries ORDER BY name, version").all<Library>()).results;
}
