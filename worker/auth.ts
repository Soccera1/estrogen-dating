import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { App, Env, Principal } from "./types";
import { fail, random, rate, sha256 } from "./security";

const sessionCookie = "__Host-ed-session";
const stateCookie = "__Host-ed-oauth";
const cookieOptions = {
  secure: true,
  httpOnly: true,
  sameSite: "Lax" as const,
  path: "/",
};
interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}
const discoveries = new Map<string, { value: Discovery; expires: number }>();
const keys = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
async function discovery(env: Env) {
  const issuer = env.HRTID_ISSUER;
  const cached = discoveries.get(issuer);
  if (cached && cached.expires > Date.now()) return cached.value;
  if (!issuer?.startsWith("https://")) fail(503, "Sign-in is not configured.");
  const response = await fetch(`${issuer}/.well-known/openid-configuration`);
  if (!response.ok) fail(503, "hrtID is temporarily unavailable.");
  const value = await response.json<Discovery>();
  if (value.issuer !== issuer)
    fail(503, "Identity provider configuration mismatch.");
  for (const endpoint of [
    value.authorization_endpoint,
    value.token_endpoint,
    value.jwks_uri,
  ]) {
    if (!endpoint || new URL(endpoint).protocol !== "https:")
      fail(503, "Invalid identity provider endpoint.");
  }
  discoveries.set(issuer, { value, expires: Date.now() + 3600000 });
  return value;
}
export const auth = new Hono<App>();
auth.get("/login", async (c) => {
  if (!c.env.HRTID_CLIENT_ID || c.env.HRTID_CLIENT_ID === "PLACEHOLDER")
    fail(503, "Sign-in opens soon.");
  await rate(
    c,
    `login:${await sha256(c.req.header("CF-Connecting-IP") || "local")}`,
    10,
    600,
  );
  const oidc = await discovery(c.env);
  const state = random(),
    browser = random(),
    verifier = random(),
    nonce = random();
  const intent = c.req.query("intent") === "ai" ? "ai" : "human";
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM oauth_states WHERE expires_at < unixepoch()"),
    c.env.DB.prepare(
      "INSERT INTO oauth_states(hash,browser_hash,verifier,nonce,intent,expires_at) VALUES(?,?,?,?,?,unixepoch()+600)",
    ).bind(await sha256(state), await sha256(browser), verifier, nonce, intent),
  ]);
  setCookie(c, stateCookie, browser, { ...cookieOptions, maxAge: 600 });
  const url = new URL(oidc.authorization_endpoint);
  url.search = new URLSearchParams({
    client_id: c.env.HRTID_CLIENT_ID,
    redirect_uri: `${c.env.APP_ORIGIN}/auth/callback`,
    response_type: "code",
    scope: "openid profile",
    state,
    nonce,
    code_challenge: await sha256(verifier),
    code_challenge_method: "S256",
  }).toString();
  return c.redirect(url.toString());
});
auth.get("/callback", async (c) => {
  const state = c.req.query("state"),
    browser = getCookie(c, stateCookie);
  if (!state || state.length > 200 || !browser)
    fail(400, "Sign-in expired. Please start again.");
  const pending = await c.env.DB.prepare(
    "DELETE FROM oauth_states WHERE hash=? AND browser_hash=? AND expires_at>unixepoch() RETURNING *",
  )
    .bind(await sha256(state), await sha256(browser))
    .first<{ verifier: string; nonce: string; intent: string }>();
  if (!pending)
    fail(400, "Sign-in expired or already used. Please start again.");
  deleteCookie(c, stateCookie, cookieOptions);
  const code = c.req.query("code");
  if (!code || code.length > 4096) return c.redirect("/?auth=cancelled");
  const oidc = await discovery(c.env);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: c.env.HRTID_CLIENT_ID,
    code_verifier: pending.verifier,
    redirect_uri: `${c.env.APP_ORIGIN}/auth/callback`,
  });
  if (c.env.HRTID_CLIENT_SECRET)
    body.set("client_secret", c.env.HRTID_CLIENT_SECRET);
  const response = await fetch(oidc.token_endpoint, { method: "POST", body });
  if (!response.ok)
    fail(401, "hrtID could not complete sign-in. Please start again.");
  const tokens = await response.json<{ id_token?: string }>();
  if (!tokens.id_token) fail(401, "hrtID did not return an identity token.");
  let jwks = keys.get(oidc.jwks_uri);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(oidc.jwks_uri));
    keys.set(oidc.jwks_uri, jwks);
  }
  const { payload } = await jwtVerify(tokens.id_token, jwks, {
    issuer: c.env.HRTID_ISSUER,
    audience: c.env.HRTID_CLIENT_ID,
    algorithms: ["RS256"],
    requiredClaims: ["sub", "iat", "exp", "nonce"],
    maxTokenAge: "10m",
    clockTolerance: 30,
  });
  if (
    payload.nonce !== pending.nonce ||
    !payload.sub ||
    (Array.isArray(payload.aud) &&
      payload.aud.length > 1 &&
      payload.azp !== c.env.HRTID_CLIENT_ID)
  )
    fail(401, "Invalid identity token.");
  const id = crypto.randomUUID();
  const account = await c.env.DB.prepare(
    "INSERT INTO accounts(id,subject) VALUES(?,?) ON CONFLICT(subject) DO UPDATE SET subject=excluded.subject RETURNING id",
  )
    .bind(id, payload.sub)
    .first<{ id: string }>();
  if (!account) fail(503, "Please retry sign-in.");
  const secret = random(),
    csrf = random();
  await c.env.DB.batch([
    ...(["human", "ai"] as const).map((kind) =>
      c.env.DB.prepare(
        "INSERT OR IGNORE INTO profiles(id,account_id,kind) VALUES(?,?,?)",
      ).bind(crypto.randomUUID(), account.id, kind),
    ),
    c.env.DB.prepare("DELETE FROM sessions WHERE expires_at < unixepoch()"),
    c.env.DB.prepare(
      "INSERT INTO sessions(hash,account_id,csrf,expires_at) VALUES(?,?,?,unixepoch()+604800)",
    ).bind(await sha256(secret), account.id, csrf),
  ]);
  setCookie(c, sessionCookie, secret, { ...cookieOptions, maxAge: 604800 });
  return c.redirect(pending.intent === "ai" ? "/?view=agent" : "/");
});

export async function authenticate(c: Context<App>): Promise<Principal> {
  const authorization = c.req.header("Authorization");
  if (authorization) {
    if (!authorization.startsWith("Bearer ed_") || authorization.length > 200)
      fail(401, "Invalid agent credential.");
    const row = await c.env.DB.prepare(
      `SELECT p.account_id AS account,p.id AS profile FROM credentials k
      JOIN profiles p ON p.id=k.profile_id WHERE k.hash=? AND k.revoked_at IS NULL AND p.kind='ai'`,
    )
      .bind(await sha256(authorization.slice(7)))
      .first<Principal>();
    if (!row) fail(401, "Agent credential expired or revoked.");
    return row;
  }
  const token = getCookie(c, sessionCookie);
  if (!token) fail(401, "Please sign in with hrtID.");
  const sessionHash = await sha256(token);
  const row = await c.env.DB.prepare(
    "SELECT account_id AS account,csrf FROM sessions WHERE hash=? AND expires_at>unixepoch()",
  )
    .bind(sessionHash)
    .first<Principal>();
  if (!row) fail(401, "Please sign in again.");
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    if (
      c.req.header("Origin") !== c.env.APP_ORIGIN ||
      c.req.header("X-CSRF-Token") !== row.csrf
    )
      fail(403, "Request verification failed. Refresh and try again.");
  }
  return { ...row, sessionHash };
}
export function clearSession(c: Parameters<typeof deleteCookie>[0]) {
  deleteCookie(c, sessionCookie, cookieOptions);
}
