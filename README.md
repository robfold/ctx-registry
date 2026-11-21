# ctx-registry

English · [한국어](README.ko.md)

An open-source alternative to Context7 that runs on your own Cloudflare account.

Your coding agent connects one MCP address, asks a question, and gets back the right sections of a library's official docs. ctx-registry uses the same two tools as Context7, `resolve-library-id` and `query-docs`, so prompts written for Context7 keep working. It runs on one Cloudflare Worker with D1 (keyword search), Vectorize (meaning search), and Workers AI (embeddings). There is no monthly cap, and a million questions cost about $11 at Cloudflare list prices.

- **Keyword and meaning search together.** Both run at once and their rankings are merged, so a question about "middleware" still finds Next.js 16's "proxy" docs, and an exact API name still matches word for word.
- **You pick the source and the version.** Build packages from the maintainers' repo or docs site with the [`@neuledge/context`](https://github.com/neuledge/context) CLI. `next@16.2.9` and `next@16.4.6` stay side by side.
- **Offline copies, if you want them.** The same server is a package registry for the `context` CLI, so a machine can download a package once and search it locally.

## How it works

```
agent ──MCP──▶ Worker ──┬─▶ D1 (FTS5)                  keyword ranking
                        └─▶ Workers AI ─▶ Vectorize      meaning ranking
                         ◀── merged (reciprocal rank fusion), trimmed to a token budget
```

| Path | What it does |
|---|---|
| `POST /t/<READ_TOKEN>/mcp` | MCP over Streamable HTTP (JSON responses, no sessions). Tools: `resolve-library-id`, `query-docs`. |
| `POST /mcp` with `Authorization: Bearer <READ_TOKEN>` | The same, for clients that can send headers. |
| `PUT /t/<READ_TOKEN>/index/{name}/{version}` | Index a batch of sections. Needs `Authorization: Bearer <PUBLISH_TOKEN>`. Used by `bin/ctx-index.mjs`. |
| `GET /t/<READ_TOKEN>/libraries` | Every indexed library with its section count. |
| `GET /t/<READ_TOKEN>/search`, `.../packages/...` | Package registry for the `context` CLI (download and search offline). |
| `GET /healthz` | `ok`, no token. |

`query-docs` takes `libraryId` as `name@version`, a bare `name` (newest version), or a Context7-style `/org/project`, which is matched against the library's source URL. Any other path answers 404.

## Deploy

You need a Cloudflare account on Workers Paid and Node 22.13 or later.

```sh
git clone https://github.com/robfold/ctx-registry && cd ctx-registry
npm install
npx wrangler d1 create ctx-docs                      # paste the printed id into wrangler.jsonc
npx wrangler d1 migrations apply ctx-docs --remote
npx wrangler vectorize create ctx-docs-vectors --dimensions=1024 --metric=cosine
npx wrangler r2 bucket create ctx-registry
npm run cf:deploy                                    # typecheck + tests + wrangler deploy
openssl rand -hex 32 | npx wrangler secret put READ_TOKEN
openssl rand -hex 32 | npx wrangler secret put PUBLISH_TOKEN
```

Keep both tokens in your password manager. Until both secrets are set, every path except `/healthz` answers 404. Tokens shorter than 32 characters are refused. To run on keyword search alone, remove the `ai` and `vectorize` entries from `wrangler.jsonc`.

## Connect an agent

Claude Code:

```sh
claude mcp add --transport http docs https://ctx-registry.<subdomain>.workers.dev/t/<READ_TOKEN>/mcp
```

Other MCP clients:

```json
{ "mcpServers": { "docs": { "url": "https://ctx-registry.<subdomain>.workers.dev/t/<READ_TOKEN>/mcp" } } }
```

## Load docs

```sh
export CTX_REGISTRY_URL=https://ctx-registry.<subdomain>.workers.dev/t/<READ_TOKEN>
export CTX_PUBLISH_TOKEN=<PUBLISH_TOKEN>

context add https://github.com/honojs/hono       # build a package on your machine
node bin/ctx-index.mjs --all                      # index everything in ~/.context/packages for MCP search
node bin/ctx-publish.mjs --all                    # optional: also offer the files for offline download
```

Both scripts skip what the server already holds. `ctx-index --force` re-sends everything (for example after turning on meaning search). To keep some packages off the server, list one regex per line in `~/.config/ctx-registry/exclude`; each line is matched against `name@version` and the package's source URL.

## Cost

At Cloudflare list prices, one question is one 1,024-dimension Vectorize query ($0.01 per million queried dimensions), one Workers AI embedding of the question (`@cf/baai/bge-m3`, $0.012 per million tokens), and one Worker request: about $11 per million questions, on top of the $5 Workers Paid plan. Embedding a section costs the same per token, so indexing 100,000 sections (at most 2,000 characters each are embedded) costs under a dollar.

## Limits

- Answers are the docs' own sections. Context7 also writes a short summary for each code example; ctx-registry does not.
- You choose and load the libraries. Automatic rebuilds are not in this release.
- The read token works like an API key, and there is no rate limit for anyone who holds it. Rotate it with `wrangler secret put READ_TOKEN` if it leaks.
- An index batch is at most 200 sections; `ctx-index` splits packages for you.

## Test

```sh
npm run check    # tsc + vitest
```

The tests run the handlers on Node's built-in SQLite with the real migration (FTS5, triggers, bm25), plus stand-ins for Workers AI and Vectorize that enforce Vectorize's per-call limits.

## License

Apache-2.0. Packages are built with `@neuledge/context` (Apache-2.0). This project is not affiliated with Context7, Upstash, or Neuledge.
