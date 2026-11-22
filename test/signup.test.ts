import { beforeEach, describe, expect, it } from "vitest";
import { handleSignup } from "../site/src/worker";
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

  it("keeps one row per email and does not wipe earlier libraries with an empty field", async () => {
    await post({ email: "dev@example.com", libraries: "next" });
    await post({ email: "dev@example.com", libraries: "" });
    expect(rows()).toEqual([{ email: "dev@example.com", libraries: "next", lang: "en" }]);
  });

  it("answers bots that fill the hidden field without storing them", async () => {
    expect((await post({ email: "bot@example.com", website: "http://spam.test" })).status).toBe(200);
    expect(rows()).toEqual([]);
  });
});
