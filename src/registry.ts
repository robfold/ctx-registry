/**
 * ctx-registry: a private registry server for the `@neuledge/context` CLI.
 *
 * The CLI only calls two endpoints, with no auth headers:
 *   GET {server}/search?registry=&name=&version=      -> JSON array, first item = latest
 *   GET {server}/packages/{registry}/{name}/{version}/download -> SQLite package file
 * So the read gate is a secret path prefix: {server} = https://host/t/<READ_TOKEN>.
 *
 * Our own packages live in R2. Anything we do not hold is proxied to the
 * public upstream registry, so this server can be the CLI's only default.
 */

export interface Env {
  REGISTRY: R2Bucket;
  READ_TOKEN: string;
  PUBLISH_TOKEN: string;
  UPSTREAM_URL?: string;
}

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export interface Entry {
  registry: string;
  name: string;
  version: string;
  size?: number;
  description?: string;
  sections?: number;
  source?: string;
  uploaded?: string;
  origin: "local" | "upstream";
}

/** Registry name used for packages we build ourselves (no npm/pip identity). */
export const LOCAL_REGISTRY = "docs";
const DEFAULT_UPSTREAM = "https://api.context.neuledge.com";
const MIN_TOKEN_LENGTH = 32;
const MAX_UPLOAD_BYTES = 95 * 1024 * 1024; // request body limit is 100 MB on Free/Pro
const UPSTREAM_TIMEOUT_MS = 8000;
const SQLITE_MAGIC = new TextEncoder().encode("SQLite format 3\u0000");
const META_LIMIT = 500; // R2 customMetadata is capped at 2 KB in total

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const json = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  }
  return diff === 0;
}

const tokenOk = (given: string | undefined, expected: string | undefined) =>
  !!given && !!expected && expected.length >= MIN_TOKEN_LENGTH && safeEqual(given, expected);

const enc = encodeURIComponent;

export const objectKey = (registry: string, name: string, version: string) =>
  `pkg/${enc(registry)}/${enc(name)}/${enc(version)}.db`;

function parseKey(key: string): { registry: string; name: string; version: string } | null {
  const m = /^pkg\/([^/]+)\/([^/]+)\/([^/]+)\.db$/.exec(key);
  if (!m) return null;
  return {
    registry: decodeURIComponent(m[1]!),
    name: decodeURIComponent(m[2]!),
    version: decodeURIComponent(m[3]!),
  };
}

function toEntry(obj: R2Object): Entry | null {
  const id = parseKey(obj.key);
  if (!id) return null;
  const meta = obj.customMetadata ?? {};
  const sections = Number(meta.sections);
  return {
    ...id,
    size: obj.size,
    ...(meta.description ? { description: meta.description } : {}),
    ...(Number.isFinite(sections) && meta.sections ? { sections } : {}),
    ...(meta.source ? { source: meta.source } : {}),
    uploaded: meta.uploaded ?? obj.uploaded.toISOString(),
    origin: "local",
  };
}

async function listAll(bucket: R2Bucket, prefix: string): Promise<R2Object[]> {
  const out: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, include: ["customMetadata"] });
    out.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out;
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

/** Newest first: semver versions by number, then everything else by upload time. */
export function compareEntries(a: Entry, b: Entry): number {
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
  return (b.uploaded ?? "").localeCompare(a.uploaded ?? "");
}

/** Our copy may be stored under the asked registry or under LOCAL_REGISTRY. */
const candidateRegistries = (registry: string) =>
  registry === LOCAL_REGISTRY ? [LOCAL_REGISTRY] : [registry, LOCAL_REGISTRY];

async function localSearch(env: Env, registry: string, name: string, version?: string) {
  const found: Entry[] = [];
  for (const r of candidateRegistries(registry)) {
    for (const obj of await listAll(env.REGISTRY, `pkg/${enc(r)}/${enc(name)}/`)) {
      const e = toEntry(obj);
      if (e && (!version || e.version === version)) found.push(e);
    }
  }
  return found.sort(compareEntries);
}

async function upstreamSearch(
  env: Env,
  fetcher: Fetcher,
  registry: string,
  name: string,
  version?: string,
): Promise<Entry[]> {
  const params = new URLSearchParams({ registry, name });
  if (version) params.set("version", version);
  const res = await fetcher(`${upstream(env)}/search?${params}`, {
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!res.ok) throw new HttpError(502, `upstream search ${res.status}`);
  const rows = (await res.json()) as unknown;
  if (!Array.isArray(rows)) throw new HttpError(502, "upstream search returned non-array");
  return rows
    .filter((r): r is Omit<Entry, "origin"> => !!r && typeof r.name === "string" && typeof r.version === "string")
    .map((r) => ({ ...r, origin: "upstream" as const }));
}

const upstream = (env: Env) => (env.UPSTREAM_URL || DEFAULT_UPSTREAM).replace(/\/+$/, "");

async function search(env: Env, fetcher: Fetcher, url: URL): Promise<Response> {
  const name = url.searchParams.get("name")?.trim();
  if (!name) throw new HttpError(400, "name is required");
  const registry = url.searchParams.get("registry")?.trim() || "npm";
  const version = url.searchParams.get("version")?.trim() || undefined;
  const localOnly = url.searchParams.get("local") === "1";

  const ours = await localSearch(env, registry, name, version);
  if (localOnly) return json(ours);

  let theirs: Entry[] = [];
  let upstreamError: string | undefined;
  try {
    theirs = await upstreamSearch(env, fetcher, registry, name, version);
  } catch (err) {
    upstreamError = err instanceof Error ? err.message : String(err);
  }
  if (upstreamError && ours.length === 0) {
    return json({ error: `upstream unavailable: ${upstreamError}` }, 502);
  }
  const held = new Set(ours.map((e) => e.version));
  const merged = [...ours, ...theirs.filter((e) => !held.has(e.version))];
  return json(merged, 200, upstreamError ? { "x-ctx-upstream-error": upstreamError } : {});
}

async function download(
  env: Env,
  fetcher: Fetcher,
  registry: string,
  name: string,
  version: string,
): Promise<Response> {
  for (const r of candidateRegistries(registry)) {
    const obj = await env.REGISTRY.get(objectKey(r, name, version));
    if (obj) {
      return new Response(obj.body, {
        headers: {
          "content-type": "application/vnd.sqlite3",
          "content-length": String(obj.size),
          "x-ctx-origin": "local",
          "x-ctx-registry": r,
        },
      });
    }
  }
  const res = await fetcher(`${upstream(env)}/packages/${enc(registry)}/${enc(name)}/${enc(version)}/download`);
  if (!res.ok || !res.body) {
    return json({ error: `not found here or upstream (${res.status})` }, res.status === 404 ? 404 : 502);
  }
  const headers = new Headers({ "content-type": "application/vnd.sqlite3", "x-ctx-origin": "upstream" });
  const len = res.headers.get("content-length");
  if (len) headers.set("content-length", len);
  return new Response(res.body, { headers });
}

const readMeta = (req: Request, header: string) => {
  const raw = req.headers.get(header);
  if (!raw) return undefined;
  try {
    return decodeURIComponent(raw).slice(0, META_LIMIT);
  } catch {
    throw new HttpError(400, `${header} must be percent-encoded`);
  }
};

async function publish(
  env: Env,
  req: Request,
  registry: string,
  name: string,
  version: string,
): Promise<Response> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_UPLOAD_BYTES) throw new HttpError(413, "package too large");
  const body = new Uint8Array(await req.arrayBuffer());
  if (body.byteLength > MAX_UPLOAD_BYTES) throw new HttpError(413, "package too large");
  if (body.byteLength < 512 || !SQLITE_MAGIC.every((b, i) => body[i] === b)) {
    throw new HttpError(400, "body is not a SQLite package file");
  }
  const customMetadata: Record<string, string> = { uploaded: new Date().toISOString() };
  const description = readMeta(req, "x-ctx-description");
  const source = readMeta(req, "x-ctx-source");
  const sections = req.headers.get("x-ctx-sections");
  if (description) customMetadata.description = description;
  if (source) customMetadata.source = source;
  if (sections && /^\d+$/.test(sections)) customMetadata.sections = sections;

  await env.REGISTRY.put(objectKey(registry, name, version), body, {
    httpMetadata: { contentType: "application/vnd.sqlite3" },
    customMetadata,
  });
  return json({ registry, name, version, size: body.byteLength }, 201);
}

async function index(env: Env): Promise<Response> {
  const entries = (await listAll(env.REGISTRY, "pkg/"))
    .map(toEntry)
    .filter((e): e is Entry => e !== null)
    .sort((a, b) => a.name.localeCompare(b.name) || compareEntries(a, b));
  return json(entries);
}

function decodeSegments(parts: string[]): string[] {
  try {
    return parts.map((p) => decodeURIComponent(p));
  } catch {
    throw new HttpError(400, "malformed path encoding");
  }
}

export async function handle(req: Request, env: Env, fetcher: Fetcher): Promise<Response> {
  const url = new URL(req.url);
  try {
    if (url.pathname === "/healthz") return new Response("ok\n");

    // /t/<token>/<rest...>; every unauthenticated path looks like a plain 404.
    const raw = url.pathname.split("/").filter(Boolean);
    if (raw[0] !== "t" || !tokenOk(raw[1], env.READ_TOKEN)) {
      return json({ error: "not found" }, 404);
    }
    const route = decodeSegments(raw.slice(2));
    const method = req.method.toUpperCase();

    if (route.length === 1 && route[0] === "search" && method === "GET") {
      return await search(env, fetcher, url);
    }
    if (route.length === 1 && route[0] === "index" && method === "GET") {
      return await index(env);
    }
    if (route[0] === "packages") {
      const [, registry, name, version, action] = route;
      if (registry && name && version) {
        if (route.length === 5 && action === "download" && method === "GET") {
          return await download(env, fetcher, registry, name, version);
        }
        if (route.length === 4 && (method === "PUT" || method === "DELETE")) {
          const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
          if (!tokenOk(bearer, env.PUBLISH_TOKEN)) return json({ error: "unauthorized" }, 401);
          if (method === "PUT") return await publish(env, req, registry, name, version);
          await env.REGISTRY.delete(objectKey(registry, name, version));
          return json({ deleted: { registry, name, version } });
        }
      }
    }
    return json({ error: "not found" }, 404);
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status);
    console.error("ctx-registry error", err);
    return json({ error: "internal error" }, 500);
  }
}
