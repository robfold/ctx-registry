/**
 * Landing page Worker: static pages from ./public, plus one endpoint that stores
 * "Get your URL" sign-ups. It only stores them; nothing is emailed automatically.
 */

export interface SiteEnv {
  DB: D1Database;
  ASSETS: Fetcher;
}

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

export async function handleSignup(req: Request, db: D1Database, now = new Date().toISOString()): Promise<Response> {
  if (req.method !== "POST") return json({ error: "use POST" }, 405);
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }
  // Bots fill every field; people never see this one.
  if (typeof body.website === "string" && body.website.trim() !== "") return json({ ok: true });

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (email.length > 320 || !EMAIL.test(email)) return json({ error: "email" }, 400);
  const libraries = typeof body.libraries === "string" ? body.libraries.trim().slice(0, 300) : "";
  const lang = body.lang === "ko" ? "ko" : "en";

  await db
    .prepare(
      `INSERT INTO waitlist (email, libraries, lang, created, updated) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (email) DO UPDATE SET libraries = coalesce(nullif(excluded.libraries, ''), waitlist.libraries),
         lang = excluded.lang, updated = excluded.updated`,
    )
    .bind(email, libraries || null, lang, now, now)
    .run();
  return json({ ok: true });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/api/signup") return handleSignup(req, env.DB);
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<SiteEnv>;
