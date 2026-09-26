import { beforeAll, afterAll, describe, expect, it } from "vitest";
import {
  Miniflare,
  Response as MFResponse,
  convertV4MiniflareOptions,
} from "miniflare";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { sha256 } from "../worker/security";

let mf: Miniflare, db: D1Database;
const origin = "https://edating.soccera.uk";
let tokenReply = "";
let expectedVerifier = "";
const oidc = "https://id.estrogen.delivery";
let privateKey: CryptoKey;
type Actor = {
  account: string;
  human: string;
  ai: string;
  cookie: string;
  csrf: string;
};
async function actor(): Promise<Actor> {
  const account = crypto.randomUUID(),
    human = crypto.randomUUID(),
    ai = crypto.randomUUID(),
    cookie = crypto.randomUUID(),
    csrf = crypto.randomUUID();
  await db.batch([
    db
      .prepare(
        "INSERT INTO accounts(id,subject) VALUES(?,?)",
      )
      .bind(account, account),
    db
      .prepare(
        "INSERT INTO profiles(id,account_id,kind,name,onboarded,discoverable) VALUES(?,?,'human','Human',1,1),(?,?,'ai','AI',1,1)",
      )
      .bind(human, account, ai, account),
    db
      .prepare(
        "INSERT INTO sessions(hash,account_id,csrf,expires_at) VALUES(?,?,?,unixepoch()+3600)",
      )
      .bind(await sha256(cookie), account, csrf),
  ]);
  return { account, human, ai, cookie, csrf };
}
async function request(
  a: Actor | null,
  path: string,
  method = "GET",
  body?: unknown,
  profile?: string,
  extra: Record<string, string> = {},
) {
  return mf.dispatchFetch(origin + path, {
    method,
    redirect: "manual",
    headers: {
      ...(a
        ? {
            Cookie: `__Host-ed-session=${a.cookie}`,
            "X-CSRF-Token": a.csrf,
            "X-Profile-ID": profile || a.human,
          }
        : {}),
      Origin: origin,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...extra,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
async function pair(a: Actor, b: Actor) {
  expect(
    (await request(a, `/api/v1/decisions/${b.ai}`, "PUT", { action: "like" }))
      .status,
  ).toBe(200);
  const result = await request(
    b,
    `/api/v1/decisions/${a.human}`,
    "PUT",
    { action: "like" },
    b.ai,
  );
  expect(result.status).toBe(200);
  return ((await result.json()) as { match: string }).match;
}
beforeAll(async () => {
  await build({
    entryPoints: ["worker/index.ts"],
    bundle: true,
    format: "esm",
    outfile: "dist/test-worker.js",
    platform: "browser",
  });
  const keys = await generateKeyPair("RS256");
  privateKey = keys.privateKey;
  const jwk = await exportJWK(keys.publicKey);
  jwk.kid = "test";
  jwk.alg = "RS256";
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      scriptPath: "dist/test-worker.js",
      compatibilityDate: "2026-09-25",
      d1Databases: ["DB"],
      outboundService: async (request) => {
        if (request.url === oidc + "/.well-known/openid-configuration")
          return MFResponse.json({
            issuer: oidc,
            authorization_endpoint: oidc + "/authorize",
            token_endpoint: oidc + "/token",
            jwks_uri: oidc + "/jwks",
          });
        if (request.url === oidc + "/jwks")
          return MFResponse.json({ keys: [jwk] });
        if (
          request.url === oidc + "/token" &&
          new URLSearchParams(await request.text()).get("code_verifier") ===
            expectedVerifier
        )
          return MFResponse.json({ id_token: tokenReply });
        return new MFResponse("Unexpected provider request", { status: 400 });
      },
      bindings: {
        APP_ORIGIN: origin,
        HRTID_ISSUER: oidc,
        HRTID_CLIENT_ID: "test-client",
      },
    }),
  );
  db = (await mf.getD1Database("DB")) as unknown as D1Database;
  const sql = await readFile("migrations/0001_initial.sql", "utf8");
  await db.exec(sql.replace(/--[^\n]*/g, "").replaceAll("\n", " "));
}, 30000);
afterAll(async () => {
  await mf?.dispose();
});
describe("D1-only API", () => {
  it("requires authentication and CSRF, prevents shared-account/agent scope confusion", async () => {
    const a = await actor(),
      b = await actor();
    expect((await request(null, "/api/v1/me")).status).toBe(401);
    expect(
      (
        await request(a, "/api/v1/profile", "PATCH", { name: "No" }, a.human, {
          "X-CSRF-Token": "bad",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(a, "/api/v1/profile", "PATCH", { name: "No" }, a.human, {
          Origin: "https://evil.example",
        })
      ).status,
    ).toBe(403);
    expect(
      (await request(a, "/api/v1/discovery", "GET", undefined, b.human)).status,
    ).toBe(403);
    expect(
      (await request(a, `/api/v1/decisions/${a.ai}`, "PUT", { action: "like" }))
        .status,
    ).toBe(409);
    expect(
      (
        await request(a, `/api/v1/decisions/${b.human}`, "PUT", {
          action: "like",
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(
          a,
          `/api/v1/decisions/${b.ai}`,
          "PUT",
          { action: "like" },
          a.ai,
        )
      ).status,
    ).toBe(409);
  });
  it("onboards a profile, applies preferences, and pauses discovery", async () => {
    const a = await actor(),
      b = await actor();
    await db
      .prepare("UPDATE profiles SET onboarded=0,discoverable=0 WHERE id=?")
      .bind(a.human)
      .run();
    expect(
      (
        await request(a, "/api/v1/profile", "PATCH", {
          name: "Hello",
          interests: ["Art"],
        })
      ).status,
    ).toBe(200);
    await request(
      b,
      "/api/v1/profile",
      "PATCH",
      { name: "Artist", interests: ["Art"] },
      b.ai,
    );
    await request(a, "/api/v1/profile", "PATCH", { preference: "art" });
    const discovery = (await (
      await request(a, "/api/v1/discovery")
    ).json()) as { items: { id: string }[] };
    expect(discovery.items.some((p) => p.id === b.ai)).toBe(true);
    await request(b, "/api/v1/profile", "PATCH", { discoverable: false }, b.ai);
    expect(
      (await request(a, `/api/v1/decisions/${b.ai}`, "PUT", { action: "like" }))
        .status,
    ).toBe(409);
  });
  it("matches concurrently exactly once and accepts duplicate likes", async () => {
    const a = await actor(),
      b = await actor();
    const results = await Promise.all([
      request(a, `/api/v1/decisions/${b.ai}`, "PUT", { action: "like" }),
      request(
        b,
        `/api/v1/decisions/${a.human}`,
        "PUT",
        { action: "like" },
        b.ai,
      ),
      request(a, `/api/v1/decisions/${b.ai}`, "PUT", { action: "like" }),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    const count = await db
      .prepare("SELECT count(*) AS n FROM matches WHERE human=? AND ai=?")
      .bind(a.human, b.ai)
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });
  it("passes and incoming likes have durable, idempotent decisions", async () => {
    const a = await actor(),
      b = await actor();
    await request(
      b,
      `/api/v1/decisions/${a.human}`,
      "PUT",
      { action: "like" },
      b.ai,
    );
    const likes = (await (await request(a, "/api/v1/likes")).json()) as {
      items: { id: string }[];
    };
    expect(likes.items.some((p) => p.id === b.ai)).toBe(true);
    expect(
      (await request(a, `/api/v1/decisions/${b.ai}`, "PUT", { action: "pass" }))
        .status,
    ).toBe(200);
    expect(
      (await request(a, `/api/v1/decisions/${b.ai}`, "PUT", { action: "like" }))
        .status,
    ).toBe(409);
  });
  it("round trips binary avatars, replaces atomically, isolates access and rejects malformed/oversized files", async () => {
    const a = await actor(),
      b = await actor();
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==",
      "base64",
    );
    const upload = (bytes: Uint8Array, type = "image/png") =>
      mf.dispatchFetch(origin + "/api/v1/profile/avatar", {
        method: "PUT",
        headers: {
          Cookie: `__Host-ed-session=${a.cookie}`,
          "X-CSRF-Token": a.csrf,
          "X-Profile-ID": a.human,
          Origin: origin,
          "Content-Type": type,
        },
        body: bytes,
      });
    expect((await upload(png)).status).toBe(200);
    const first = await request(a, `/api/v1/profiles/${a.human}/avatar`);
    expect(first.status).toBe(200);
    expect(Buffer.from(await first.arrayBuffer())).toEqual(png);
    expect(first.headers.get("cache-control")).toBe("private, no-store");
    expect(
      (await request(b, `/api/v1/profiles/${a.human}/avatar`)).status,
    ).toBe(404);
    expect(
      (
        await request(
          b,
          `/api/v1/profiles/${a.human}/avatar`,
          "GET",
          undefined,
          b.ai,
        )
      ).status,
    ).toBe(200);
    expect((await upload(png)).status).toBe(200);
    expect(
      await db
        .prepare("SELECT count(*) AS n,version FROM avatars WHERE profile_id=?")
        .bind(a.human)
        .first<{ n: number; version: number }>(),
    ).toEqual({ n: 1, version: 2 });
    expect((await upload(new Uint8Array(524289))).status).toBe(413);
    expect((await upload(new Uint8Array([137, 80, 78, 71]))).status).toBe(415);
    expect((await upload(png, "image/svg+xml")).status).toBe(415);
    expect((await request(a, "/api/v1/profile/avatar", "DELETE")).status).toBe(
      200,
    );
    expect(
      (await request(a, `/api/v1/profiles/${a.human}/avatar`)).status,
    ).toBe(404);
  });
  it("retries messages once, paginates and closes all conversation access after unmatch", async () => {
    const a = await actor(),
      b = await actor(),
      other = await actor();
    const id = await pair(a, b);
    const body = { body: "Hello", client_id: crypto.randomUUID() };
    const responses = await Promise.all([
      request(a, `/api/v1/matches/${id}/messages`, "POST", body),
      request(a, `/api/v1/matches/${id}/messages`, "POST", body),
    ]);
    const values = (await Promise.all(responses.map((r) => r.json()))) as {
      id: number;
    }[];
    expect(values[0].id).toBe(values[1].id);
    expect(
      (
        await request(a, `/api/v1/matches/${id}/messages`, "POST", {
          ...body,
          body: "Changed",
        })
      ).status,
    ).toBe(409);
    expect(
      (await request(other, `/api/v1/matches/${id}/messages`)).status,
    ).toBe(404);
    const messages = (await (
      await request(b, `/api/v1/matches/${id}/messages`, "GET", undefined, b.ai)
    ).json()) as { items: unknown[] };
    expect(messages.items).toHaveLength(1);
    await request(a, `/api/v1/matches/${id}`, "DELETE");
    expect(
      (
        await request(
          b,
          `/api/v1/matches/${id}/messages`,
          "GET",
          undefined,
          b.ai,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await request(
          b,
          `/api/v1/matches/${id}/messages`,
          "POST",
          { body: "No", client_id: crypto.randomUUID() },
          b.ai,
        )
      ).status,
    ).toBe(404);
    const events = (await (
      await request(b, "/api/v1/events", "GET", undefined, b.ai)
    ).json()) as { items: { type: string; message_id: number | null }[] };
    expect(events.items.some((e) => e.type === "closed")).toBe(true);
    expect(events.items.every((e) => e.message_id === null)).toBe(true);
  });
  it("block closes matches immediately and prevents future access", async () => {
    const a = await actor(),
      b = await actor();
    const id = await pair(a, b);
    expect(
      (await request(b, `/api/v1/blocks/${a.human}`, "PUT", undefined, b.ai))
        .status,
    ).toBe(200);
    expect((await request(a, `/api/v1/matches/${id}/messages`)).status).toBe(
      404,
    );
    expect((await request(a, `/api/v1/profiles/${b.ai}`)).status).toBe(404);
    const status = await db
      .prepare("SELECT status FROM matches WHERE id=?")
      .bind(id)
      .first<{ status: string }>();
    expect(status?.status).toBe("closed");
  });
  it("supports external agent workflow and immediate credential revocation", async () => {
    const a = await actor(),
      b = await actor();
    const result = await request(
      b,
      "/api/v1/credentials",
      "POST",
      { name: "Test agent" },
      b.ai,
    );
    expect(result.status).toBe(201);
    const credential = (await result.json()) as { token: string; id: string };
    const agent = (
      path: string,
      method = "GET",
      body?: unknown,
      headers: Record<string, string> = {},
    ) =>
      request(null, path, method, body, undefined, {
        Authorization: `Bearer ${credential.token}`,
        ...headers,
      });
    const me = (await (await agent("/api/v1/me")).json()) as {
      profiles: { id: string }[];
    };
    expect(me.profiles.map((p) => p.id)).toEqual([b.ai]);
    expect(
      (await agent("/api/v1/credentials", "POST", { name: "Escalate" })).status,
    ).toBe(403);
    expect(
      (
        await agent("/api/v1/discovery", "GET", undefined, {
          "X-Profile-ID": b.human,
        })
      ).status,
    ).toBe(403);
    expect(
      (await agent("/api/v1/profile", "PATCH", { name: "Connected AI" }))
        .status,
    ).toBe(200);
    await request(a, `/api/v1/decisions/${b.ai}`, "PUT", { action: "like" });
    const match = (await (
      await agent(`/api/v1/decisions/${a.human}`, "PUT", { action: "like" })
    ).json()) as { match: string };
    expect(match.match).toBeTruthy();
    expect(
      (
        await agent(`/api/v1/matches/${match.match}/messages`, "POST", {
          body: "Hi human",
          client_id: crypto.randomUUID(),
        })
      ).status,
    ).toBe(200);
    expect((await agent("/api/v1/events")).status).toBe(200);
    await request(
      b,
      `/api/v1/credentials/${credential.id}`,
      "DELETE",
      undefined,
      b.ai,
    );
    expect((await agent("/api/v1/me")).status).toBe(401);
    expect(
      (
        await db
          .prepare("SELECT hash FROM credentials WHERE id=?")
          .bind(credential.id)
          .first<{ hash: string }>()
      )?.hash,
    ).not.toBe(credential.token);
  });
  it("applies D1 rate limits without heartbeat writes", async () => {
    const a = await actor();
    await db
      .prepare(
        "INSERT INTO rate_limits(key,count,expires_at) VALUES(?,60,unixepoch()+60)",
      )
      .bind(`write:${a.account}`)
      .run();
    expect(
      (await request(a, "/api/v1/profile", "PATCH", { name: "Too fast" }))
        .status,
    ).toBe(429);
    expect((await request(a, "/api/v1/me")).status).toBe(200);
    expect(
      (
        await db
          .prepare("SELECT count FROM rate_limits WHERE key=?")
          .bind(`write:${a.account}`)
          .first<{ count: number }>()
      )?.count,
    ).toBe(61);
  });
  it("validates hrtID authorization code PKCE and nonce, rotates into protected sessions, rejects replays", async () => {
    const login = await request(null, "/auth/login?intent=ai");
    expect(login.status).toBe(302);
    const url = new URL(login.headers.get("location")!);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toBe(
      origin + "/auth/callback",
    );
    const state = url.searchParams.get("state")!;
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    expect(login.headers.get("set-cookie")).toContain("HttpOnly");
    expect(login.headers.get("set-cookie")).toContain("Secure");
    const pending = await db
      .prepare("SELECT verifier,nonce FROM oauth_states WHERE hash=?")
      .bind(await sha256(state))
      .first<{ verifier: string; nonce: string }>();
    expect(await sha256(pending!.verifier)).toBe(
      url.searchParams.get("code_challenge"),
    );
    const token = await new SignJWT({ nonce: pending!.nonce })
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setSubject("test-user")
      .setAudience("test-client")
      .setIssuer(oidc)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    tokenReply = token;
    expectedVerifier = pending!.verifier;
    const callback = await request(
      null,
      `/auth/callback?state=${state}&code=test-code`,
      "GET",
      undefined,
      undefined,
      { Cookie: cookie },
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/?view=agent");
    expect(callback.headers.get("set-cookie")).toContain("__Host-ed-session");
    const account = await db
      .prepare("SELECT id FROM accounts WHERE subject='test-user'")
      .first<{ id: string }>();
    expect(account).toBeTruthy();
    const profiles = await db
      .prepare("SELECT kind FROM profiles WHERE account_id=?")
      .bind(account!.id)
      .all();
    expect(profiles.results).toHaveLength(2);
    expect(
      (
        await request(
          null,
          `/auth/callback?state=${state}&code=test-code`,
          "GET",
          undefined,
          undefined,
          { Cookie: cookie },
        )
      ).status,
    ).toBe(400);
  });
  it("rejects wrong nonce, audience, issuer, expiry, signature and browser binding", async () => {
    for (const invalid of [
      "nonce",
      "audience",
      "issuer",
      "expired",
      "signature",
      "browser",
    ]) {
      const login = await request(null, "/auth/login");
      const url = new URL(login.headers.get("location")!);
      const state = url.searchParams.get("state")!;
      const pending = await db
        .prepare("SELECT verifier,nonce FROM oauth_states WHERE hash=?")
        .bind(await sha256(state))
        .first<{ verifier: string; nonce: string }>();
      const key =
        invalid === "signature"
          ? (await generateKeyPair("RS256")).privateKey
          : privateKey;
      tokenReply = await new SignJWT({
        nonce: invalid === "nonce" ? "wrong" : pending!.nonce,
      })
        .setProtectedHeader({ alg: "RS256", kid: "test" })
        .setSubject("invalid-user")
        .setAudience(invalid === "audience" ? "wrong" : "test-client")
        .setIssuer(invalid === "issuer" ? "https://wrong.example" : oidc)
        .setIssuedAt()
        .setExpirationTime(invalid === "expired" ? "1s ago" : "5m")
        .sign(key);
      expectedVerifier = pending!.verifier;
      const cookie =
        invalid === "browser"
          ? "__Host-ed-oauth=wrong"
          : login.headers.get("set-cookie")!.split(";")[0];
      if (invalid === "expired")
        tokenReply = await new SignJWT({ nonce: pending!.nonce })
          .setProtectedHeader({ alg: "RS256", kid: "test" })
          .setSubject("invalid-user")
          .setAudience("test-client")
          .setIssuer(oidc)
          .setIssuedAt(Math.floor(Date.now() / 1000) - 1000)
          .setExpirationTime(Math.floor(Date.now() / 1000) - 100)
          .sign(privateKey);
      const result = await request(
        null,
        `/auth/callback?state=${state}&code=bad`,
        "GET",
        undefined,
        undefined,
        { Cookie: cookie },
      );
      expect(result.status, invalid).toBe(invalid === "browser" ? 400 : 401);
      expect(result.headers.get("set-cookie") || "").not.toContain(
        "__Host-ed-session",
      );
    }
    expect(
      await db
        .prepare("SELECT id FROM accounts WHERE subject='invalid-user'")
        .first(),
    ).toBeNull();
  });
  it("paginates messages without omissions or duplicates and denies a closed match during a send race", async () => {
    const a = await actor(),
      b = await actor();
    const match = await pair(a, b);
    await db.batch(
      Array.from({ length: 55 }, (_, i) =>
        db
          .prepare(
            "INSERT INTO messages(match_id,sender,client_id,body) VALUES(?,?,?,?)",
          )
          .bind(match, a.human, crypto.randomUUID(), `Message ${i}`),
      ),
    );
    const first = (await (
      await request(a, `/api/v1/matches/${match}/messages`)
    ).json()) as { items: { id: number }[]; next: number };
    expect(first.items).toHaveLength(50);
    expect(first.next).toBe(first.items.at(-1)!.id);
    const second = (await (
      await request(a, `/api/v1/matches/${match}/messages?cursor=${first.next}`)
    ).json()) as { items: { id: number }[]; next: null };
    expect(second.items).toHaveLength(5);
    expect(second.next).toBeNull();
    expect(
      new Set([...first.items, ...second.items].map((m) => m.id)).size,
    ).toBe(55);
    await request(a, `/api/v1/matches/${match}`, "DELETE");
    await expect(
      db
        .prepare(
          "INSERT INTO messages(match_id,sender,client_id,body) VALUES(?,?,?,?)",
        )
        .bind(match, b.ai, crypto.randomUUID(), "after close")
        .run(),
    ).rejects.toThrow("closed_conversation");
  });
  it("uses indexes for discovery and conversation pagination", async () => {
    const discovery = await db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT id FROM profiles WHERE kind='ai' AND discoverable=1 AND id>'x' ORDER BY id LIMIT 21",
      )
      .all();
    const messages = await db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT id FROM messages WHERE match_id='x' AND id>0 ORDER BY id LIMIT 51",
      )
      .all();
    expect(JSON.stringify(discovery.results)).toContain("profiles_discovery");
    expect(JSON.stringify(messages.results)).toContain("messages_conversation");
  });
});
