import { beforeEach, describe, expect, it, vi } from "vitest";
import { indexBatch } from "../src/docs";
import { handle, type Env, type Fetcher } from "../src/registry";
import { fakeD1 } from "./d1-sqlite";

const READ = "r".repeat(40);
const PUB = "p".repeat(40);
let env: Env;
const upstream = vi.fn<Fetcher>();

const rpc = (body: unknown, path = `/t/${READ}/mcp`, headers: HeadersInit = {}) =>
  handle(
    new Request(`https://reg.test${path}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    }),
    env,
    upstream,
  );

const call = async (name: string, args: Record<string, unknown>) => {
  const res = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  return ((await res.json()) as { result: { content: { text: string }[]; isError?: boolean } }).result;
};

beforeEach(async () => {
  const db = fakeD1();
  env = { DB: db, REGISTRY: {} as R2Bucket, READ_TOKEN: READ, PUBLISH_TOKEN: PUB };
  await indexBatch(db, {
    library: { name: "next", version: "16.4.6", description: "The React framework", source: "https://github.com/vercel/next.js" },
    chunks: [
      { seq: 1, doc_path: "docs/middleware.md", doc_title: "Middleware", section_title: "Overview", content: "Middleware runs before routes.", tokens: 10 },
    ],
    reset: true,
    final: true,
  });
});

describe("MCP handshake", () => {
  it("agrees on a supported protocol version and falls back to the newest otherwise", async () => {
    const init = async (v: string) =>
      ((await (await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: v } })).json()) as {
        result: { protocolVersion: string; capabilities: { tools: object } };
      }).result;
    expect((await init("2025-06-18")).protocolVersion).toBe("2025-06-18");
    expect((await init("1999-01-01")).protocolVersion).toBe("2025-11-25");
    expect((await init("2025-06-18")).capabilities.tools).toBeDefined();
  });

  it("accepts notifications with 202 and refuses batches and GET streams", async () => {
    expect((await rpc({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
    expect((await rpc([{ jsonrpc: "2.0", id: 1, method: "ping" }])).status).toBe(400);
    const get = await handle(new Request(`https://reg.test/t/${READ}/mcp`), env, upstream);
    expect(get.status).toBe(405);
  });

  it("lists the two Context7-style tools", async () => {
    const res = (await (await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json()) as { result: { tools: { name: string }[] } };
    expect(res.result.tools.map((t) => t.name)).toEqual(["resolve-library-id", "query-docs"]);
  });
});

describe("MCP tools", () => {
  it("resolves a library name to IDs with versions", async () => {
    const result = await call("resolve-library-id", { libraryName: "next" });
    expect(result.content[0]!.text).toContain("Library ID: next@16.4.6");
    expect(result.content[0]!.text).toContain("Versions: 16.4.6");
  });

  it("answers a docs question with sections and their sources", async () => {
    const result = await call("query-docs", { libraryId: "next@16.4.6", query: "middleware" });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain("### Middleware > Overview");
    expect(result.content[0]!.text).toContain("Source: docs/middleware.md");
  });

  it("says plainly when a library is missing", async () => {
    const result = await call("query-docs", { libraryId: "react", query: "hooks" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("resolve-library-id");
  });
});

describe("MCP and index access", () => {
  it("takes the read token in the path or as a bearer token on /mcp, and hides /mcp otherwise", async () => {
    const ping = { jsonrpc: "2.0", id: 9, method: "ping" };
    expect((await rpc(ping, "/mcp", { authorization: `Bearer ${READ}` })).status).toBe(200);
    expect((await rpc(ping, "/mcp", { authorization: `Bearer ${"x".repeat(40)}` })).status).toBe(404);
    expect((await rpc(ping, "/mcp")).status).toBe(404);
  });

  it("indexes only with the publish token and a body that matches the path", async () => {
    const put = (path: string, body: unknown, token = PUB) =>
      handle(
        new Request(`https://reg.test/t/${READ}${path}`, { method: "PUT", body: JSON.stringify(body), headers: { authorization: `Bearer ${token}` } }),
        env,
        upstream,
      );
    const batch = { library: { name: "hono", version: "latest" }, chunks: [], reset: true, final: true };
    expect((await put("/index/hono/latest", batch, READ)).status).toBe(401);
    expect((await put("/index/hono/other", batch)).status).toBe(400);
    expect((await put("/index/zod/1.0.0", { library: { name: "zod", version: "1.0.0" }, chunks: [] })).status).toBe(409);
    expect((await put("/index/hono/latest", batch)).status).toBe(200);
  });
});
