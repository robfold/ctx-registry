import { beforeEach, describe, expect, it, vi } from "vitest";
import { compareEntries, handle, objectKey, type Entry, type Env, type Fetcher } from "../src/registry";

const READ = "r".repeat(40);
const PUB = "p".repeat(40);
const BASE = `https://reg.test/t/${READ}`;

/** In-memory stand-in for the parts of R2Bucket the registry uses. */
class FakeBucket {
  store = new Map<string, { bytes: Uint8Array; customMetadata: Record<string, string>; uploaded: Date }>();
  pageSize = 1000;

  async put(key: string, value: Uint8Array, opts: { customMetadata?: Record<string, string> } = {}) {
    this.store.set(key, { bytes: value, customMetadata: opts.customMetadata ?? {}, uploaded: new Date() });
  }
  async get(key: string) {
    const o = this.store.get(key);
    if (!o) return null;
    return { key, size: o.bytes.byteLength, body: new Response(o.bytes).body, customMetadata: o.customMetadata };
  }
  async delete(key: string) {
    this.store.delete(key);
  }
  async list({ prefix = "", cursor }: { prefix?: string; cursor?: string }) {
    const keys = [...this.store.keys()].filter((k) => k.startsWith(prefix)).sort();
    const start = cursor ? Number(cursor) : 0;
    const slice = keys.slice(start, start + this.pageSize);
    const truncated = start + this.pageSize < keys.length;
    return {
      objects: slice.map((key) => {
        const o = this.store.get(key)!;
        return { key, size: o.bytes.byteLength, customMetadata: o.customMetadata, uploaded: o.uploaded };
      }),
      truncated,
      cursor: truncated ? String(start + this.pageSize) : undefined,
    };
  }
}

const sqliteBytes = (fill = 1, size = 1024) => {
  const b = new Uint8Array(size).fill(fill);
  b.set(new TextEncoder().encode("SQLite format 3\u0000"));
  return b;
};

let bucket: FakeBucket;
let env: Env;
let upstream: ReturnType<typeof vi.fn<Fetcher>>;

const call = (path: string, init?: RequestInit) => handle(new Request(`${BASE}${path}`, init), env, upstream);

const publish = (registry: string, name: string, version: string, body = sqliteBytes(), headers: HeadersInit = {}) =>
  call(`/packages/${registry}/${encodeURIComponent(name)}/${version}`, {
    method: "PUT",
    body,
    headers: { authorization: `Bearer ${PUB}`, ...headers },
  });

beforeEach(() => {
  bucket = new FakeBucket();
  env = { REGISTRY: bucket as unknown as R2Bucket, READ_TOKEN: READ, PUBLISH_TOKEN: PUB };
  upstream = vi.fn<Fetcher>(async () => new Response("[]", { status: 200 }));
});

describe("read gate", () => {
  it("serves healthz without a token", async () => {
    const res = await handle(new Request("https://reg.test/healthz"), env, upstream);
    expect(res.status).toBe(200);
  });

  it("answers 404 for a wrong, missing, or short token", async () => {
    for (const url of [
      "https://reg.test/search?name=x",
      `https://reg.test/t/${"x".repeat(40)}/search?name=x`,
      "https://reg.test/t/short/search?name=x",
    ]) {
      expect((await handle(new Request(url), env, upstream)).status).toBe(404);
    }
    const weak = { ...env, READ_TOKEN: "short" };
    expect((await handle(new Request("https://reg.test/t/short/search?name=x"), weak, upstream)).status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe("publish", () => {
  it("requires the publish token, not the read token", async () => {
    const res = await call("/packages/docs/x/1.0.0", {
      method: "PUT",
      body: sqliteBytes(),
      headers: { authorization: `Bearer ${READ}` },
    });
    expect(res.status).toBe(401);
    expect(bucket.store.size).toBe(0);
  });

  it("rejects a body that is not a SQLite file", async () => {
    const res = await publish("docs", "x", "1.0.0", new Uint8Array(2048).fill(7));
    expect(res.status).toBe(400);
  });

  it("stores the file with decoded metadata", async () => {
    const res = await publish("docs", "@sveltejs/kit", "2.66.0", sqliteBytes(), {
      "x-ctx-description": encodeURIComponent("웹 프레임워크"),
      "x-ctx-sections": "338",
      "x-ctx-source": encodeURIComponent("https://github.com/sveltejs/kit"),
    });
    expect(res.status).toBe(201);
    const stored = bucket.store.get(objectKey("docs", "@sveltejs/kit", "2.66.0"))!;
    expect(stored.customMetadata).toMatchObject({ description: "웹 프레임워크", sections: "338" });
  });

  it("deletes with the publish token", async () => {
    await publish("docs", "x", "1.0.0");
    const res = await call("/packages/docs/x/1.0.0", { method: "DELETE", headers: { authorization: `Bearer ${PUB}` } });
    expect(res.status).toBe(200);
    expect(bucket.store.size).toBe(0);
  });
});

describe("search", () => {
  it("lists our versions newest first, falls back to the docs registry, and appends upstream", async () => {
    await publish("docs", "next", "16.2.9");
    await publish("docs", "next", "16.4.6");
    upstream.mockResolvedValueOnce(
      Response.json([
        { registry: "npm", name: "next", version: "16.4.6" },
        { registry: "npm", name: "next", version: "latest", size: 10 },
      ]),
    );
    const res = await call("/search?registry=npm&name=next");
    const rows = (await res.json()) as Entry[];
    expect(rows.map((r) => `${r.origin}:${r.version}`)).toEqual([
      "local:16.4.6",
      "local:16.2.9",
      "upstream:latest",
    ]);
    expect(upstream.mock.calls[0]![0]).toBe("https://api.context.neuledge.com/search?registry=npm&name=next");
  });

  it("skips upstream when local=1", async () => {
    await publish("docs", "asana-developers", "current");
    const rows = (await (await call("/search?registry=docs&name=asana-developers&local=1")).json()) as Entry[];
    expect(rows).toHaveLength(1);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("returns our rows when upstream fails, and 502 when we hold nothing", async () => {
    upstream.mockRejectedValue(new Error("boom"));
    expect((await call("/search?registry=npm&name=hono")).status).toBe(502);
    await publish("docs", "hono", "latest");
    const res = await call("/search?registry=npm&name=hono");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-ctx-upstream-error")).toContain("boom");
  });

  it("follows R2 list pagination", async () => {
    bucket.pageSize = 2;
    for (const v of ["1.0.0", "1.1.0", "1.2.0", "2.0.0", "2.1.0"]) await publish("docs", "lib", v);
    const rows = (await (await call("/search?registry=docs&name=lib&local=1")).json()) as Entry[];
    expect(rows.map((r) => r.version)).toEqual(["2.1.0", "2.0.0", "1.2.0", "1.1.0", "1.0.0"]);
  });

  it("requires a name", async () => {
    expect((await call("/search?registry=npm")).status).toBe(400);
  });
});

describe("download", () => {
  it("serves our copy, including names with a slash", async () => {
    const bytes = sqliteBytes(9);
    await publish("docs", "@sveltejs/kit", "2.66.0", bytes);
    const res = await call(`/packages/npm/${encodeURIComponent("@sveltejs/kit")}/2.66.0/download`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-ctx-origin")).toBe("local");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("proxies upstream for packages we do not hold", async () => {
    upstream.mockResolvedValueOnce(new Response(sqliteBytes(3), { headers: { "content-length": "1024" } }));
    const res = await call("/packages/npm/hono/latest/download");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-ctx-origin")).toBe("upstream");
    expect(upstream.mock.calls[0]![0]).toBe("https://api.context.neuledge.com/packages/npm/hono/latest/download");
  });

  it("passes an upstream 404 through", async () => {
    upstream.mockResolvedValueOnce(new Response("{}", { status: 404 }));
    expect((await call("/packages/npm/nope/1.0.0/download")).status).toBe(404);
  });
});

describe("index and ordering", () => {
  it("lists every package we hold", async () => {
    await publish("docs", "b", "1.0.0");
    await publish("npm", "a", "1.0.0");
    const rows = (await (await call("/index")).json()) as Entry[];
    expect(rows.map((r) => `${r.registry}/${r.name}`)).toEqual(["npm/a", "docs/b"]);
  });

  it("puts semver before labels and labels by upload time", () => {
    const e = (version: string, uploaded = "2026-01-01") => ({ registry: "docs", name: "x", version, uploaded, origin: "local" as const });
    const sorted = [e("main", "2026-01-01"), e("1.2.0"), e("current", "2026-06-01"), e("1.10.0")].sort(compareEntries);
    expect(sorted.map((x) => x.version)).toEqual(["1.10.0", "1.2.0", "current", "main"]);
  });
});
