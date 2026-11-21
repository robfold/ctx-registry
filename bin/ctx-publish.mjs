#!/usr/bin/env node
// Publish `context` package files (.db) to a ctx-registry server.
//
//   ctx-publish <file.db>... [--registry docs]
//   ctx-publish --all [--dir ~/.context/packages] [--exclude-file <path>] [--registry docs] [--dry-run]
//
// Env: CTX_REGISTRY_URL (the server URL with /t/<READ_TOKEN>), CTX_PUBLISH_TOKEN.
// Needs Node 22.13+ for node:sqlite.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { DatabaseSync } from "node:sqlite";

const { values: opts, positionals: files } = parseArgs({
  allowPositionals: true,
  options: {
    all: { type: "boolean", default: false },
    dir: { type: "string", default: join(homedir(), ".context", "packages") },
    "exclude-file": { type: "string", default: join(homedir(), ".config", "ctx-registry", "exclude") },
    registry: { type: "string", default: "docs" },
    "dry-run": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (opts.help || (!opts.all && files.length === 0)) {
  console.log(readFileSync(new URL(import.meta.url)).toString().split("\n").slice(1, 9).join("\n"));
  process.exit(opts.help ? 0 : 1);
}

const server = process.env.CTX_REGISTRY_URL?.replace(/\/+$/, "");
const token = process.env.CTX_PUBLISH_TOKEN;
if (!opts["dry-run"] && (!server || !token)) {
  console.error("Set CTX_REGISTRY_URL and CTX_PUBLISH_TOKEN.");
  process.exit(1);
}

function readPackage(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const meta = Object.fromEntries(db.prepare("SELECT key, value FROM meta").all().map((r) => [r.key, r.value]));
    const { count } = db.prepare("SELECT COUNT(*) AS count FROM chunks").get();
    if (!meta.name || !meta.version) throw new Error("missing name or version in meta table");
    return { path, name: meta.name, version: meta.version, description: meta.description, source: meta.source_url, sections: count, size: statSync(path).size };
  } finally {
    db.close();
  }
}

/** One regex per line, matched against "name@version" and the source URL. */
function loadExcludes(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => new RegExp(l));
}

async function remoteIndex() {
  const res = await fetch(`${server}/index`);
  if (!res.ok) throw new Error(`index: HTTP ${res.status}`);
  const held = new Map();
  for (const e of await res.json()) held.set(`${e.registry}/${e.name}@${e.version}`, e.size);
  return held;
}

async function publish(pkg, registry) {
  const enc = encodeURIComponent;
  const res = await fetch(`${server}/packages/${enc(registry)}/${enc(pkg.name)}/${enc(pkg.version)}`, {
    method: "PUT",
    body: readFileSync(pkg.path),
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/vnd.sqlite3",
      "x-ctx-sections": String(pkg.sections),
      ...(pkg.description ? { "x-ctx-description": enc(pkg.description) } : {}),
      ...(pkg.source ? { "x-ctx-source": enc(pkg.source) } : {}),
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
}

const paths = opts.all
  ? readdirSync(opts.dir).filter((f) => f.endsWith(".db") && !f.startsWith(".")).map((f) => join(opts.dir, f))
  : files;
const excludes = loadExcludes(opts["exclude-file"]);
const held = opts["dry-run"] || !server ? new Map() : await remoteIndex();

let sent = 0, skipped = 0, excluded = 0, failed = 0;
for (const path of paths.sort()) {
  let pkg;
  try {
    pkg = readPackage(path);
  } catch (err) {
    console.error(`FAIL  ${path}: ${err.message}`);
    failed++;
    continue;
  }
  const id = `${pkg.name}@${pkg.version}`;
  if (excludes.some((re) => re.test(id) || (pkg.source && re.test(pkg.source)))) {
    console.log(`SKIP  ${id} (excluded)`);
    excluded++;
    continue;
  }
  if (held.get(`${opts.registry}/${id}`) === pkg.size) {
    skipped++;
    continue;
  }
  if (opts["dry-run"]) {
    console.log(`DRY   ${opts.registry}/${id} ${pkg.size} bytes`);
    sent++;
    continue;
  }
  try {
    await publish(pkg, opts.registry);
    console.log(`OK    ${opts.registry}/${id} ${pkg.size} bytes`);
    sent++;
  } catch (err) {
    console.error(`FAIL  ${id}: ${err.message}`);
    failed++;
  }
}
console.log(`\n${opts["dry-run"] ? "would publish" : "published"} ${sent}, unchanged ${skipped}, excluded ${excluded}, failed ${failed}`);
process.exit(failed ? 1 : 0);
