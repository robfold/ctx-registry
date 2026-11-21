# ctx-registry

English · [한국어](README.ko.md)

Official library docs for your coding agents, for the version you run, with no quota. One Cloudflare Worker and one R2 bucket.

It serves the [`@neuledge/context`](https://github.com/neuledge/context) CLI and MCP server. Build a package from a library's official docs once on one machine, publish it, and every other machine and agent installs the same file. Packages you do not hold are fetched from the public Neuledge registry, so you can point the CLI at this server and nothing else.

- **Search runs on the agent's machine.** The server only hands out SQLite files. After install, a query costs nothing and works offline.
- **You pick the source and the version.** Build from the official repo or docs site, keep every version you pin, and update a package when you choose to.
- **It costs close to nothing.** R2 has no egress fees. One install is at most two R2 lists (Class A) and two reads (Class B), because a lookup also checks the `docs` registry: under $10 per million installs at list price. The R2 free tier holds 10 GB.

## How it works

The `context` CLI calls two endpoints and sends no auth headers:

```
GET {server}/search?registry=npm&name=next                  -> [{registry, name, version, size, description}, ...]  first = latest
GET {server}/packages/{registry}/{name}/{version}/download  -> the package .db file
```

So the read gate is a secret path: `{server}` is `https://<worker>/t/<READ_TOKEN>`. Any other path answers 404.

| Request | What happens |
|---|---|
| `search` | Your versions first (semver newest first, then labels such as `main` by upload time), then upstream versions you do not hold. Add `&local=1` to skip upstream. |
| `download` | Your copy if you hold it, otherwise streamed from upstream. |
| `PUT /packages/{registry}/{name}/{version}` | Publish. Needs `Authorization: Bearer <PUBLISH_TOKEN>`. The body must be a SQLite file. |
| `DELETE /packages/{registry}/{name}/{version}` | Remove. Same bearer token. |
| `GET /index` | Everything you hold. |
| `GET /healthz` | `ok`, no token. |

Packages you build yourself go under the registry name `docs`. A search or download for `npm/next` also looks in `docs/next`, so `context install npm/next@16.4.6` finds the copy you built.

## Deploy

You need a Cloudflare account and Node 22.13 or later.

```sh
git clone https://github.com/robfold/ctx-registry && cd ctx-registry
npm install
export CLOUDFLARE_ACCOUNT_ID=<your account id>
npx wrangler r2 bucket create ctx-registry
npm run cf:deploy          # typecheck + tests + wrangler deploy

openssl rand -hex 32 | npx wrangler secret put READ_TOKEN
openssl rand -hex 32 | npx wrangler secret put PUBLISH_TOKEN
```

Keep both tokens in your password manager. Until both secrets are set, every path except `/healthz` answers 404. Tokens shorter than 32 characters are refused.

## Point the CLI at it

Edit `~/.context/config.json` on each machine:

```json
{
  "servers": [
    { "name": "mine", "url": "https://ctx-registry.<subdomain>.workers.dev/t/<READ_TOKEN>", "default": true },
    { "name": "neuledge", "url": "https://api.context.neuledge.com" }
  ]
}
```

Then `context browse`, `context install`, and the MCP tools `search_packages` and `download_package` use your server. `chmod 600` the file: it holds the read token.

## Publish

```sh
export CTX_REGISTRY_URL=https://ctx-registry.<subdomain>.workers.dev/t/<READ_TOKEN>
export CTX_PUBLISH_TOKEN=<PUBLISH_TOKEN>

context add https://github.com/honojs/hono --name hono --pkg-version 4.12.27   # build locally
node bin/ctx-publish.mjs ~/.context/packages/hono@4.12.27.db                  # publish one file
node bin/ctx-publish.mjs --all --dry-run                                      # everything in ~/.context/packages
node bin/ctx-publish.mjs --all
```

`--all` skips packages the server already holds at the same size. To keep some packages off the server, list one regex per line in `~/.config/ctx-registry/exclude`; each line is matched against `name@version` and the package's source URL.

## Limits

- The read token sits in a URL and in `~/.context/config.json`. Treat it like an API key, and rotate it with `wrangler secret put READ_TOKEN` if it leaks.
- There is no rate limit. Anyone with the read token can download as much as they like.
- A publish is held in memory, so a package must be under 95 MB (the request body limit on Free and Pro plans is 100 MB).
- Building packages (`context add`) runs on your machine, not in the Worker.

## Test

```sh
npm run check    # tsc + vitest
```

The tests run the request handler against an in-memory R2 stand-in and a fake upstream.

## License

Apache-2.0, the same as `@neuledge/context`. This project is not affiliated with Neuledge.
