import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { App, Profile } from "./types";
import { auth, authenticate, clearSession } from "./auth";
import {
  cursor,
  fail,
  jsonBody,
  random,
  rate,
  readBytes,
  sha256,
  string,
} from "./security";
import { validateAvatar, toHex, fromHex } from "./avatar";

const app = new Hono<App>();
const publicProfile = (p: Profile) => ({
  id: p.id,
  kind: p.kind,
  name: p.name,
  pronouns: p.pronouns,
  bio: p.bio,
  interests: JSON.parse(p.interests),
  prompt: p.prompt,
  discoverable: Boolean(p.discoverable),
  onboarded: Boolean(p.onboarded),
  avatar: p.avatar_version
    ? `/api/v1/profiles/${p.id}/avatar?v=${p.avatar_version}`
    : null,
});
const ownedProfile = (p: Profile) => ({
  ...publicProfile(p),
  preference: p.preference,
});
const blocked = `NOT EXISTS(SELECT 1 FROM blocks b WHERE (b.actor=? AND b.target=p.id) OR (b.target=? AND b.actor=p.id))`;
app.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
  await next();
});
app.route("/auth", auth);
app.get("/api/v1/status", (c) =>
  c.json({
    name: "Estrogen Dating",
    version: "1",
    loginReady: Boolean(
      c.env.HRTID_CLIENT_ID && c.env.HRTID_CLIENT_ID !== "PLACEHOLDER",
    ),
  }),
);
app.use("/api/v1/*", async (c, next) => {
  c.set("principal", await authenticate(c));
  if (!["GET", "HEAD"].includes(c.req.method))
    await rate(
      c,
      `write:${c.get("principal").profile || c.get("principal").account}`,
      60,
    );
  await next();
});
app.get("/api/v1/me", async (c) => {
  const principal = c.get("principal");
  const profiles = await c.env.DB.prepare(
    `SELECT * FROM profiles WHERE account_id=? ${principal.profile ? "AND id=?" : ""}`,
  )
    .bind(
      ...(principal.profile
        ? [principal.account, principal.profile]
        : [principal.account]),
    )
    .all<Profile>();
  return c.json({
    profiles: profiles.results.map(ownedProfile),
    csrf: principal.csrf,
    agent: Boolean(principal.profile),
  });
});
app.post("/api/v1/logout", async (c) => {
  const p = c.get("principal");
  if (p.profile) fail(403, "Agents cannot manage browser sessions.");
  await c.env.DB.prepare("DELETE FROM sessions WHERE hash=?")
    .bind(p.sessionHash)
    .run();
  clearSession(c);
  return c.json({ ok: true });
});
app.use("/api/v1/*", async (c, next) => {
  const principal = c.get("principal");
  const id = principal.profile || c.req.header("X-Profile-ID");
  if (
    !id ||
    (principal.profile &&
      c.req.header("X-Profile-ID") &&
      c.req.header("X-Profile-ID") !== id)
  )
    fail(403, "Select an authorized profile.");
  const profile = await c.env.DB.prepare(
    "SELECT * FROM profiles WHERE id=? AND account_id=?",
  )
    .bind(id, principal.account)
    .first<Profile>();
  if (!profile) fail(403, "Profile access denied.");
  c.set("profile", profile);
  await next();
});
app.patch("/api/v1/profile", async (c) => {
  const p = c.get("profile"),
    body = await jsonBody(c);
  const name = string(body.name ?? p.name, "Name", 60, 1);
  const pronouns = string(body.pronouns ?? p.pronouns, "Pronouns", 60);
  const bio = string(body.bio ?? p.bio, "Bio", 1500);
  const prompt = string(body.prompt ?? p.prompt, "Conversation prompt", 300);
  const preference = string(
    body.preference ?? p.preference,
    "Interest filter",
    40,
  );
  const interests = body.interests ?? JSON.parse(p.interests);
  if (!Array.isArray(interests) || interests.length > 10)
    fail(400, "Choose up to 10 interests.");
  const cleanInterests = [
    ...new Set(interests.map((item) => string(item, "Interest", 40, 1))),
  ];
  if ("discoverable" in body && typeof body.discoverable !== "boolean")
    fail(400, "Discoverable must be true or false.");
  const discoverable =
    body.discoverable === undefined
      ? p.onboarded
        ? p.discoverable
        : 1
      : Number(body.discoverable);
  await c.env.DB.prepare(
    "UPDATE profiles SET name=?,pronouns=?,bio=?,prompt=?,interests=?,preference=?,discoverable=?,onboarded=1 WHERE id=?",
  )
    .bind(
      name,
      pronouns,
      bio,
      prompt,
      JSON.stringify(cleanInterests),
      preference,
      discoverable,
      p.id,
    )
    .run();
  return c.json(
    ownedProfile({
      ...p,
      name,
      pronouns,
      bio,
      prompt,
      interests: JSON.stringify(cleanInterests),
      preference,
      discoverable,
      onboarded: 1,
    }),
  );
});
async function visible(
  c: Parameters<typeof authenticate>[0],
  id: string,
  withAvatar = false,
) {
  const me = c.get("profile");
  const p = await c.env.DB.prepare(
    `SELECT p.* ${withAvatar ? ",a.content_type,hex(a.bytes) AS hex" : ""}
    FROM profiles p ${withAvatar ? "LEFT JOIN avatars a ON a.profile_id=p.id" : ""} WHERE p.id=? AND (
    p.id=? OR (p.account_id<>? AND p.kind<>? AND p.onboarded=1 AND ${blocked}
    AND (p.discoverable=1 OR EXISTS(SELECT 1 FROM matches m WHERE m.status='active' AND m.human IN (?,p.id) AND m.ai IN (?,p.id)))
    AND NOT EXISTS(SELECT 1 FROM matches m WHERE m.status='closed' AND m.human IN (?,p.id) AND m.ai IN (?,p.id))))`,
  )
    .bind(
      id,
      me.id,
      me.account_id,
      me.kind,
      me.id,
      me.id,
      me.id,
      me.id,
      me.id,
      me.id,
    )
    .first<Profile & { content_type?: string; hex?: string }>();
  if (!p) fail(404, "Profile unavailable.");
  return p;
}
app.get("/api/v1/profiles/:id", async (c) =>
  c.json(publicProfile(await visible(c, c.req.param("id")))),
);
app.get("/api/v1/discovery", async (c) => {
  const p = c.get("profile");
  if (!p.onboarded) fail(403, "Complete your profile first.");
  const rows = await c.env.DB.prepare(
    `SELECT p.* FROM profiles p WHERE p.kind=? AND p.discoverable=1 AND p.id>?
    AND p.account_id<>? AND p.onboarded=1 AND ${blocked}
    AND NOT EXISTS(SELECT 1 FROM decisions WHERE actor=? AND target=p.id)
    AND NOT EXISTS(SELECT 1 FROM matches WHERE human IN (?,p.id) AND ai IN (?,p.id))
    AND (?='' OR EXISTS(SELECT 1 FROM json_each(p.interests) WHERE lower(value)=lower(?))) ORDER BY p.id LIMIT 21`,
  )
    .bind(
      p.kind === "human" ? "ai" : "human",
      cursor(c),
      p.account_id,
      p.id,
      p.id,
      p.id,
      p.id,
      p.id,
      p.preference,
      p.preference,
    )
    .all<Profile>();
  const items = rows.results.slice(0, 20);
  return c.json({
    items: items.map(publicProfile),
    next: rows.results.length > 20 ? items.at(-1)!.id : null,
  });
});
app.get("/api/v1/likes", async (c) => {
  const me = c.get("profile");
  const rows = await c.env.DB.prepare(
    `SELECT p.* FROM decisions d JOIN profiles p ON p.id=d.actor
    WHERE d.target=? AND d.action='like' AND d.actor>? AND p.discoverable=1 AND ${blocked}
    AND NOT EXISTS(SELECT 1 FROM decisions WHERE actor=? AND target=p.id)
    AND NOT EXISTS(SELECT 1 FROM matches WHERE human IN (?,p.id) AND ai IN (?,p.id)) ORDER BY d.actor LIMIT 21`,
  )
    .bind(me.id, cursor(c), me.id, me.id, me.id, me.id, me.id)
    .all<Profile>();
  const items = rows.results.slice(0, 20);
  return c.json({
    items: items.map(publicProfile),
    next: rows.results.length > 20 ? items.at(-1)!.id : null,
  });
});
app.put("/api/v1/decisions/:id", async (c) => {
  const me = c.get("profile"),
    target = c.req.param("id"),
    body = await jsonBody(c);
  if (body.action !== "like" && body.action !== "pass")
    fail(400, "Choose like or pass.");
  const old = await c.env.DB.prepare(
    "SELECT action FROM decisions WHERE actor=? AND target=?",
  )
    .bind(me.id, target)
    .first<{ action: string }>();
  if (old && old.action !== body.action)
    fail(409, "This profile already has a decision.");
  if (!old)
    await c.env.DB.prepare(
      "INSERT OR IGNORE INTO decisions(actor,target,action) VALUES(?,?,?)",
    )
      .bind(me.id, target, body.action)
      .run();
  const recorded = await c.env.DB.prepare(
    "SELECT action FROM decisions WHERE actor=? AND target=?",
  )
    .bind(me.id, target)
    .first<{ action: string }>();
  if (recorded?.action !== body.action)
    fail(409, "This profile already has a decision.");
  const match = await c.env.DB.prepare(
    `SELECT id FROM matches WHERE status='active' AND human IN (?,?) AND ai IN (?,?)`,
  )
    .bind(me.id, target, me.id, target)
    .first<{ id: string }>();
  return c.json({ ok: true, match: match?.id || null });
});
app.put("/api/v1/blocks/:id", async (c) => {
  const me = c.get("profile"),
    target = c.req.param("id");
  const p = await c.env.DB.prepare(
    "SELECT id FROM profiles WHERE id=? AND account_id<>? AND kind<>?",
  )
    .bind(target, me.account_id, me.kind)
    .first();
  if (!p) fail(404, "Profile unavailable.");
  await c.env.DB.prepare(
    "INSERT OR IGNORE INTO blocks(actor,target) VALUES(?,?)",
  )
    .bind(me.id, target)
    .run();
  return c.json({ ok: true });
});
app.get("/api/v1/matches", async (c) => {
  const me = c.get("profile");
  const rows = await c.env.DB.prepare(
    `SELECT m.id AS match_id,m.created_at AS matched_at,p.* FROM matches m
    JOIN profiles p ON p.id=CASE WHEN m.human=? THEN m.ai ELSE m.human END
    WHERE m.${me.kind === "human" ? "human" : "ai"}=? AND m.status='active' AND m.id>? ORDER BY m.id LIMIT 21`,
  )
    .bind(me.id, me.id, cursor(c))
    .all<Profile & { match_id: string; matched_at: number }>();
  const items = rows.results.slice(0, 20);
  return c.json({
    items: items.map((p) => ({
      id: p.match_id,
      created_at: p.matched_at,
      profile: publicProfile(p),
    })),
    next: rows.results.length > 20 ? items.at(-1)!.match_id : null,
  });
});
async function activeMatch(c: Parameters<typeof authenticate>[0], id: string) {
  const me = c.get("profile");
  const match = await c.env.DB.prepare(
    `SELECT * FROM matches WHERE id=? AND status='active' AND (human=? OR ai=?)`,
  )
    .bind(id, me.id, me.id)
    .first();
  if (!match) fail(404, "This conversation is closed or unavailable.");
  return match;
}
app.delete("/api/v1/matches/:id", async (c) => {
  const me = c.get("profile");
  await c.env.DB.prepare(
    `UPDATE matches SET status='closed',closed_at=unixepoch() WHERE id=? AND status='active' AND (human=? OR ai=?)`,
  )
    .bind(c.req.param("id"), me.id, me.id)
    .run();
  return c.json({ ok: true });
});
app.get("/api/v1/matches/:id/messages", async (c) => {
  await activeMatch(c, c.req.param("id"));
  // Recheck membership and active state in the same statement that reads messages.
  const me = c.get("profile");
  const rows = await c.env.DB.prepare(
    `SELECT s.id,s.sender,s.body,s.created_at,s.client_id FROM messages s JOIN matches m ON m.id=s.match_id
    WHERE m.id=? AND m.status='active' AND (m.human=? OR m.ai=?) AND s.id>? ORDER BY s.id LIMIT 51`,
  )
    .bind(c.req.param("id"), me.id, me.id, cursor(c, true))
    .all<{ id: number }>();
  const items = rows.results.slice(0, 50);
  return c.json({
    items,
    next: rows.results.length > 50 ? items.at(-1)!.id : null,
  });
});
app.post("/api/v1/matches/:id/messages", async (c) => {
  const me = c.get("profile"),
    match = c.req.param("id"),
    body = await jsonBody(c);
  const text = string(body.body, "Message", 4000, 1),
    clientId = string(body.client_id, "Client ID", 100, 8);
  await activeMatch(c, match);
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT OR IGNORE INTO messages(match_id,sender,client_id,body) VALUES(?,?,?,?)",
    ).bind(match, me.id, clientId, text),
    c.env.DB.prepare(
      "SELECT id,match_id,sender,body,created_at,client_id FROM messages WHERE sender=? AND client_id=?",
    ).bind(me.id, clientId),
  ]);
  const message = results[1].results[0] as { match_id: string; body: string };
  if (message.match_id !== match || message.body !== text)
    fail(409, "Client ID already used for a different message.");
  return c.json(message);
});
app.get("/api/v1/events", async (c) => {
  const me = c.get("profile");
  // Return tombstones so consumers can advance past events hidden by a block/unmatch.
  const rows = await c.env.DB.prepare(
    `SELECT e.id,
    CASE WHEN e.type='closed' THEN 'closed' WHEN e.match_id IS NOT NULL AND m.status<>'active' THEN 'unavailable'
      WHEN e.other_profile IS NOT NULL AND EXISTS(SELECT 1 FROM blocks WHERE (actor=e.profile_id AND target=e.other_profile) OR (actor=e.other_profile AND target=e.profile_id)) THEN 'unavailable'
      ELSE e.type END AS type,
    CASE WHEN m.status='active' OR e.type='closed' THEN e.match_id END AS match_id,
    CASE WHEN m.status='active' THEN e.message_id END AS message_id
    FROM events e LEFT JOIN matches m ON m.id=e.match_id WHERE e.profile_id=? AND e.id>? ORDER BY e.id LIMIT 50`,
  )
    .bind(me.id, cursor(c, true))
    .all<{ id: number }>();
  return c.json({
    items: rows.results,
    cursor: rows.results.at(-1)?.id || Number(cursor(c, true)),
    poll_after: 60,
  });
});
app.get("/api/v1/credentials", async (c) => {
  if (c.get("principal").profile)
    fail(403, "Only the account owner can manage credentials.");
  const rows = await c.env.DB.prepare(
    "SELECT id,name,created_at,revoked_at FROM credentials WHERE profile_id=? ORDER BY created_at DESC LIMIT 50",
  )
    .bind(c.get("profile").id)
    .all();
  return c.json({ items: rows.results });
});
app.post("/api/v1/credentials", async (c) => {
  const me = c.get("profile");
  if (c.get("principal").profile || me.kind !== "ai")
    fail(403, "Only the account owner can connect an AI profile.");
  if (!me.onboarded) fail(400, "Set up your AI profile first.");
  const body = await jsonBody(c),
    name = string(body.name, "Credential name", 60, 1);
  const count = await c.env.DB.prepare(
    "SELECT COUNT(*) AS count FROM credentials WHERE profile_id=? AND revoked_at IS NULL",
  )
    .bind(me.id)
    .first<{ count: number }>();
  if (count && count.count >= 5)
    fail(409, "Revoke an existing credential first (maximum 5).");
  const token = `ed_${random()}`,
    id = crypto.randomUUID();
  await c.env.DB.prepare(
    "INSERT INTO credentials(id,hash,profile_id,name) VALUES(?,?,?,?)",
  )
    .bind(id, await sha256(token), me.id, name)
    .run();
  return c.json({ id, token, profile_id: me.id }, 201);
});
app.delete("/api/v1/credentials/:id", async (c) => {
  if (c.get("principal").profile)
    fail(403, "Only the account owner can revoke credentials.");
  await c.env.DB.prepare(
    "UPDATE credentials SET revoked_at=COALESCE(revoked_at,unixepoch()) WHERE id=? AND profile_id=?",
  )
    .bind(c.req.param("id"), c.get("profile").id)
    .run();
  return c.json({ ok: true });
});
app.put("/api/v1/profile/avatar", async (c) => {
  const me = c.get("profile"),
    type = c.req.header("Content-Type") || "";
  const bytes = await readBytes(c.req.raw, 524288);
  validateAvatar(bytes, type);
  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE profiles SET avatar_version=avatar_version+1 WHERE id=?",
    ).bind(me.id),
    c.env.DB.prepare(
      `INSERT INTO avatars(profile_id,content_type,size,version,bytes) SELECT id,?,?,avatar_version,unhex(?) FROM profiles WHERE id=?
      ON CONFLICT(profile_id) DO UPDATE SET content_type=excluded.content_type,size=excluded.size,version=excluded.version,bytes=excluded.bytes`,
    ).bind(type, bytes.length, toHex(bytes), me.id),
  ]);
  return c.json({ ok: true });
});
app.delete("/api/v1/profile/avatar", async (c) => {
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM avatars WHERE profile_id=?").bind(
      c.get("profile").id,
    ),
    c.env.DB.prepare("UPDATE profiles SET avatar_version=0 WHERE id=?").bind(
      c.get("profile").id,
    ),
  ]);
  return c.json({ ok: true });
});
app.get("/api/v1/profiles/:id/avatar", async (c) => {
  // Authorization and binary selection share one SQL snapshot, including blocks.
  const avatar = await visible(c, c.req.param("id"), true);
  if (!avatar.hex || !avatar.content_type) fail(404, "No avatar.");
  return new Response(fromHex(avatar.hex), {
    headers: {
      "Content-Type": avatar.content_type,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
});
app.notFound((c) => c.json({ error: "Not found." }, 404));
app.onError((error, c) => {
  if (error instanceof HTTPException)
    return c.json({ error: error.message }, error.status);
  if (/invalid_pair|closed_conversation/.test(error.message))
    return c.json({ error: "This connection is unavailable." }, 409);
  if (/jwt|claim|signature|nonce|token/i.test(error.name))
    return c.json(
      { error: "Identity verification failed. Please sign in again." },
      401,
    );
  // Never expose SQL, identity tokens, message content, or stack traces.
  c.header("Retry-After", "60");
  return c.json(
    {
      error:
        "Service temporarily unavailable or free capacity reached. Your draft is safe; please retry later.",
    },
    503,
  );
});
export default app;
