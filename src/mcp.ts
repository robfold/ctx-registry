/**
 * Remote MCP endpoint (Streamable HTTP, JSON responses only, no sessions).
 * Two tools with the same names and roles as Context7's, so prompts like
 * "resolve the library id, then query the docs" keep working.
 */

import { DEFAULT_TOKENS, MAX_TOKENS, findLibrary, resolveLibraries, searchDocs, type Library, type Semantic } from "./docs";

export const SUPPORTED_PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
export const SERVER_INFO = { name: "ctx-registry", version: "0.2.0" };

const INSTRUCTIONS =
  "Up-to-date official library docs. Call resolve-library-id first to get a library ID such as next@16.4.6, " +
  "then call query-docs with that ID and a specific question. Prefer the version the project actually uses.";

export const TOOLS = [
  {
    name: "resolve-library-id",
    title: "Find a library",
    description:
      "Finds libraries whose docs this server holds and returns their library IDs (name@version) with the available versions. " +
      "Call this before query-docs unless the user already gave an ID like next@16.4.6.",
    inputSchema: {
      type: "object",
      properties: {
        libraryName: { type: "string", description: "Library or product name to look up, for example next, hono, or cloudflare-workers." },
      },
      required: ["libraryName"],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "query-docs",
    title: "Search a library's docs",
    description:
      "Returns the sections of a library's official docs that best answer a question. " +
      "libraryId is name@version (newest version if the version is left out) or a Context7-style /org/project ID.",
    inputSchema: {
      type: "object",
      properties: {
        libraryId: { type: "string", description: "Library ID from resolve-library-id, for example next@16.4.6." },
        query: { type: "string", description: "What you need to know, for example: how to add middleware that redirects unauthenticated users." },
        tokens: { type: "number", description: `Maximum tokens of docs to return (default ${DEFAULT_TOKENS}, at most ${MAX_TOKENS}).` },
      },
      required: ["libraryId", "query"],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];

type JsonRpcId = string | number | null;
interface JsonRpcMessage {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
}

const reply = (id: JsonRpcId, result: unknown) => Response.json({ jsonrpc: "2.0", id, result });
const fail = (id: JsonRpcId, code: number, message: string, status = 200) =>
  Response.json({ jsonrpc: "2.0", id, error: { code, message } }, { status });
const text = (body: string, isError = false) => ({ content: [{ type: "text", text: body }], ...(isError ? { isError: true } : {}) });

const describe = (lib: Library) =>
  [
    `- Library ID: ${lib.name}@${lib.version}`,
    lib.description ? `  Description: ${lib.description}` : null,
    lib.source ? `  Source: ${lib.source}` : null,
    `  Sections: ${lib.chunks.toLocaleString("en-US")}`,
  ]
    .filter(Boolean)
    .join("\n");

async function resolveTool(db: D1Database, args: Record<string, unknown>) {
  const asked = typeof args.libraryName === "string" ? args.libraryName : "";
  if (!asked.trim()) return text("libraryName is required.", true);
  const groups = await resolveLibraries(db, asked);
  if (groups.length === 0) {
    return text(`No library matching "${asked}" is indexed on this server. Try a shorter name, or ask the operator to publish its docs.`);
  }
  const blocks = groups.map((g) => {
    const newest = g.versions[0]!;
    const versions = g.versions.map((v) => v.version).join(", ");
    return `${describe(newest)}\n  Versions: ${versions}`;
  });
  return text(`Libraries matching "${asked}" (newest version first):\n\n${blocks.join("\n\n")}`);
}

async function queryTool(db: D1Database, args: Record<string, unknown>, semantic?: Semantic) {
  const id = typeof args.libraryId === "string" ? args.libraryId : "";
  const query = typeof args.query === "string" ? args.query : "";
  if (!id.trim() || !query.trim()) return text("libraryId and query are required.", true);
  const tokens = typeof args.tokens === "number" && Number.isFinite(args.tokens) ? args.tokens : DEFAULT_TOKENS;

  const lib = await findLibrary(db, id);
  if (!lib) return text(`Library "${id}" is not indexed on this server. Call resolve-library-id to find a valid ID.`, true);
  const sections = await searchDocs(db, lib, query, tokens, semantic);
  const head = `Library: ${lib.name}@${lib.version}${lib.source ? ` (source: ${lib.source})` : ""}\nQuery: ${query}`;
  if (sections.length === 0) {
    return text(`${head}\n\nNo section matched. Try the API or function name on its own, for example "middleware" instead of a full sentence.`);
  }
  const body = sections.map((s) => `### ${s.title}\nSource: ${s.source}\n\n${s.content}`).join("\n\n---\n\n");
  return text(`${head}\n\n${body}`);
}

export async function handleMcp(req: Request, db: D1Database, semantic?: Semantic): Promise<Response> {
  if (req.method === "GET" || req.method === "DELETE") {
    // No server-initiated stream and no sessions.
    return new Response(null, { status: 405, headers: { allow: "POST" } });
  }
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });

  let msg: JsonRpcMessage;
  try {
    msg = (await req.json()) as JsonRpcMessage;
  } catch {
    return fail(null, -32700, "Parse error", 400);
  }
  if (Array.isArray(msg) || !msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") {
    return fail(null, -32600, "Invalid Request: send one JSON-RPC 2.0 message per POST", 400);
  }
  // Notifications and responses from the client need no body.
  if (msg.id === undefined || !msg.method) return new Response(null, { status: 202 });

  const id = msg.id;
  const params = msg.params ?? {};
  switch (msg.method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      return reply(id, {
        protocolVersion: SUPPORTED_PROTOCOLS.includes(asked) ? asked : SUPPORTED_PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, { tools: TOOLS });
    case "tools/call": {
      const name = params.name;
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      if (name === "resolve-library-id") return reply(id, await resolveTool(db, args));
      if (name === "query-docs") return reply(id, await queryTool(db, args, semantic));
      return fail(id, -32602, `Unknown tool: ${String(name)}`);
    }
    default:
      return fail(id, -32601, `Method not found: ${msg.method}`);
  }
}
