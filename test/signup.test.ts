import { beforeEach, describe, expect, it } from "vitest";
import site, { handleSignup, SIGNUP_PATH } from "../site/src/worker";
import { fakeD1 } from "./d1-sqlite";

let db: ReturnType<typeof fakeD1>;
const post = (body: unknown) =>
  handleSignup(new Request("https://site.test/api/signup", { method: "POST", body: JSON.stringify(body) }), db, "2026-11-22T00:00:00Z");
const rows = () => db.raw.prepare("SELECT email, libraries, lang FROM waitlist ORDER BY id").all();

beforeEach(() => {
  db = fakeD1();
});

describe("sign-up form", () => {
  it("stores an email with the libraries a visitor uses", async () => {
    expect((await post({ email: " Dev@Example.com ", libraries: "next, hono", lang: "ko" })).status).toBe(200);
    expect(rows()).toEqual([{ email: "dev@example.com", libraries: "next, hono", lang: "ko" }]);
  });

  it("refuses something that is not an email", async () => {
    expect((await post({ email: "not-an-email" })).status).toBe(400);
    expect(rows()).toEqual([]);
  });

  it("keeps the first sign-up for an address; a later request cannot overwrite it", async () => {
    await post({ email: "dev@example.com", libraries: "next" });
    expect((await post({ email: "dev@example.com", libraries: "spam", lang: "ko" })).status).toBe(200);
    expect(rows()).toEqual([{ email: "dev@example.com", libraries: "next", lang: "en" }]);
  });

  it("answers bots that fill the hidden field without storing them", async () => {
    expect((await post({ email: "bot@example.com", website: "http://spam.test" })).status).toBe(200);
    expect(rows()).toEqual([]);
  });
});

describe("site routing under robfold.dev/ctx-registry/", () => {
  const env = () => ({ DB: db, ASSETS: { fetch: async () => new Response("asset", { status: 200 }) } }) as never;
  const send = (path: string) =>
    site.fetch(new Request(`https://robfold.dev${path}`, { method: "POST", body: JSON.stringify({ email: "dev@example.com" }) }), env(), {} as never);

  it("stores sign-ups posted to the prefixed endpoint", async () => {
    expect(SIGNUP_PATH).toBe("/ctx-registry/api/signup");
    expect((await send(SIGNUP_PATH)).status).toBe(200);
    expect(rows()).toEqual([{ email: "dev@example.com", libraries: null, lang: "en" }]);
  });

  it("does not treat the old root endpoint as the form", async () => {
    expect(await (await send("/api/signup")).text()).toBe("asset");
    expect(rows()).toEqual([]);
  });
});
