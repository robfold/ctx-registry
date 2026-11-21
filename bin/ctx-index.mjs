#!/usr/bin/env node
// Index `context` package files (.db) into the server-side search (D1), so MCP clients can query them.
//
//   ctx-index <file.db>...
//   ctx-index --all [--dir ~/.context/packages] [--exclude-file <path>] [--concurrency 4] [--force] [--dry-run]
//   --force re-sends packages the server already holds (for example after adding meaning search).
//
// Env: CTX_REGISTRY_URL (the server URL with /t/<READ_TOKEN>), CTX_PUBLISH_TOKEN.
// Needs Node 22.13+ for node:sqlite.

import { existsSync, readdirSync, readFileSync } from "node:fs";
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
    // Vectorize rate-limits bursts of upserts and deletes (40041); three packages at a time stays under it.
    concurrency: { type: "string", default: "3" },
    force: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (opts.help || (!opts.all && files.length === 0)) {
  console.log(readFileSync(new URL(import.meta.url)).toString().split("\n").slice(1, 10).join("\n"));
  process.exit(opts.help ? 0 : 1);
}

const server = process.env.CTX_REGISTRY_URL?.replace(/\/+$/, "");
const token = process.env.CTX_PUBLISH_TOKEN;
if (!opts["dry-run"] && (!server || !token)) {
  console.error("Set CTX_REGISTRY_URL and CTX_PUBLISH_TOKEN.");
  process.exit(1);
}

const MAX_CHUNKS = 200; // the server refuses bigger batches
const MAX_BYTES = 1_500_000;

function readPackage(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const meta = Object.fromEntries(db.prepare("SELECT key, value FROM meta").all().map((r) => [r.key, r.value]));
    if (!meta.name || !meta.version) throw new Error("missing name or version in meta table");
    const chunks = db
      .prepare("SELECT id AS seq, doc_path, doc_title, section_title, content, tokens FROM chunks ORDER BY id")
      .all()
      .map((c) => ({ ...c }));
    return { path, name: meta.name, version: meta.version, description: meta.description, source: meta.source_url, chunks };
  } finally {
    db.close();
  }
}

function toBatches(chunks) {
  const out = [];
  let current = [];
  let bytes = 0;
  for (const c of chunks) {
    const size = Buffer.byteLength(c.content) + Buffer.byteLength(c.doc_path) + Buffer.byteLength(c.section_title) + 200;
    if (current.length && (current.length >= MAX_CHUNKS || bytes + size > MAX_BYTES)) {
      out.push(current);
      current = [];
      bytes = 0;
    }
    current.push(c);
    bytes += size;
  }
  if (current.length || out.length === 0) out.push(current);
  return out;
}

function loadExcludes(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => new RegExp(l));
}

async function put(url, body, attempt = 1) {
  try {
    const res = await fetch(url, {
      method: "PUT",
      body: JSON.stringify(body),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    });
    if (res.ok) return;
    const text = await res.text();
    if (res.status >= 500 && attempt < 4) throw new Error(`HTTP ${res.status} ${text}`);
    throw Object.assign(new Error(`HTTP ${res.status} ${text}`), { final: true });
  } catch (err) {
    if (err.final || attempt >= 4) throw err;
    await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    return put(url, body, attempt + 1);
  }
}

async function indexPackage(pkg) {
  const enc = encodeURIComponent;
  const url = `${server}/index/${enc(pkg.name)}/${enc(pkg.version)}`;
  const library = { name: pkg.name, version: pkg.version, description: pkg.description, source: pkg.source };
  const parts = toBatches(pkg.chunks);
  for (let i = 0; i < parts.length; i++) {
    await put(url, { library, chunks: parts[i], reset: i === 0, final: i === parts.length - 1 });
  }
  return parts.length;
}

const paths = (
  opts.all ? readdirSync(opts.dir).filter((f) => f.endsWith(".db") && !f.startsWith(".")).map((f) => join(opts.dir, f)) : files
).sort();
const excludes = loadExcludes(opts["exclude-file"]);

let held = new Map();
if (!opts["dry-run"]) {
  const res = await fetch(`${server}/libraries`);
  if (!res.ok) throw new Error(`libraries: HTTP ${res.status}`);
  for (const l of await res.json()) held.set(`${l.name}@${l.version}`, l);
}

const queue = [];
let excluded = 0, unchanged = 0, failed = 0, done = 0, chunkTotal = 0;
for (const path of paths) {
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
  const have = held.get(id);
  if (!opts.force && have && have.ready === 1 && have.chunks === pkg.chunks.length) {
    unchanged++;
    continue;
  }
  queue.push(pkg);
}

const started = Date.now();
const workers = Array.from({ length: Math.max(1, Number(opts.concurrency) || 4) }, async () => {
  for (let pkg = queue.shift(); pkg; pkg = queue.shift()) {
    const id = `${pkg.name}@${pkg.version}`;
    if (opts["dry-run"]) {
      console.log(`DRY   ${id} ${pkg.chunks.length} chunks in ${toBatches(pkg.chunks).length} batches`);
      done++;
      chunkTotal += pkg.chunks.length;
      continue;
    }
    try {
      const batches = await indexPackage(pkg);
      console.log(`OK    ${id} ${pkg.chunks.length} chunks, ${batches} batches`);
      done++;
      chunkTotal += pkg.chunks.length;
    } catch (err) {
      console.error(`FAIL  ${id}: ${err.message}`);
      failed++;
    }
  }
});
await Promise.all(workers);
const secs = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\n${opts["dry-run"] ? "would index" : "indexed"} ${done} (${chunkTotal} chunks, ${secs}s), unchanged ${unchanged}, excluded ${excluded}, failed ${failed}`);
process.exit(failed ? 1 : 0);
