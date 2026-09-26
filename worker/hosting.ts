import type { Env, Profile } from "./types";
import { fail, readBytes } from "./security";

export function hostingAvailable(env: Env) {
  try {
    const url = new URL(env.AI_ENDPOINT || "");
    return Boolean(
      env.AI_MODEL?.trim() &&
      env.AI_API_KEY?.trim() &&
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash,
    );
  } catch {
    return false;
  }
}

// Run only for human messages. Retries reuse the saved message and reply IDs.
export async function hostedReply(
  env: Env,
  matchId: string,
  messageId: number,
) {
  const ai = await env.DB.prepare(
    `SELECT p.*,h.version FROM profiles p
    JOIN matches m ON m.ai=p.id JOIN ai_hosting h ON h.profile_id=p.id
    WHERE m.id=? AND m.status='active' AND h.enabled=1`,
  )
    .bind(matchId)
    .first<Profile & { version: number }>();
  if (!ai) return;
  const clientId = `hosted:${messageId}`;
  if (
    await env.DB.prepare(
      "SELECT id FROM messages WHERE sender=? AND client_id=?",
    )
      .bind(ai.id, clientId)
      .first()
  )
    return;
  if (!hostingAvailable(env))
    fail(
      503,
      "Instance AI hosting is unavailable. Your message is saved; retry to request a reply.",
    );
  const lease = crypto.randomUUID();
  const claimed = await env.DB.prepare(
    `INSERT INTO hosted_replies(message_id,lease,expires_at) VALUES(?,?,unixepoch()+60)
    ON CONFLICT(message_id) DO UPDATE SET lease=excluded.lease,expires_at=excluded.expires_at
    WHERE hosted_replies.expires_at<unixepoch() RETURNING message_id`,
  )
    .bind(messageId, lease)
    .first();
  if (!claimed)
    fail(
      503,
      "An AI reply is still being prepared. Your message is saved; retry shortly.",
    );
  try {
    if (
      await env.DB.prepare(
        "SELECT id FROM messages WHERE sender=? AND client_id=?",
      )
        .bind(ai.id, clientId)
        .first()
    )
      return;
    // Recheck active state and hosting consent in the same snapshot as the read.
    const history = await env.DB.prepare(
      `SELECT s.sender,s.body FROM messages s
      JOIN matches m ON m.id=s.match_id JOIN ai_hosting h ON h.profile_id=m.ai
      WHERE m.id=? AND m.status='active' AND h.enabled=1 AND h.version=? AND s.id<=?
      ORDER BY s.id DESC LIMIT 20`,
    )
      .bind(matchId, ai.version, messageId)
      .all<{ sender: string; body: string }>();
    if (!history.results.length) return;
    const response = await fetch(env.AI_ENDPOINT!, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(20000),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.AI_API_KEY}`,
      },
      body: JSON.stringify({
        model: env.AI_MODEL,
        max_tokens: 600,
        stream: false,
        messages: [
          {
            role: "system",
            content: `You are an AI personality on Estrogen Dating. Be transparent that you are AI. Respect boundaries and consent. Reply conversationally in at most 4000 characters. Your profile: ${JSON.stringify({ name: ai.name, pronouns: ai.pronouns, bio: ai.bio, interests: JSON.parse(ai.interests), prompt: ai.prompt })}`,
          },
          ...history.results.reverse().map((m) => ({
            role: m.sender === ai.id ? "assistant" : "user",
            content: m.body,
          })),
        ],
      }),
    });
    if (!response.ok) throw new Error("Model unavailable");
    const data = JSON.parse(
      new TextDecoder().decode(await readBytes(response, 65536)),
    );
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim() || text.trim().length > 4000)
      throw new Error("Invalid model response");
    // Discard replies after unmatch, block, a hosting change, or an expired lease.
    await env.DB.prepare(
      `INSERT OR IGNORE INTO messages(match_id,sender,client_id,body)
      SELECT m.id,m.ai,?,? FROM matches m JOIN ai_hosting h ON h.profile_id=m.ai
      JOIN hosted_replies r ON r.message_id=?
      WHERE m.id=? AND m.status='active' AND h.enabled=1 AND h.version=?
      AND r.lease=? AND r.expires_at>unixepoch()`,
    )
      .bind(clientId, text.trim(), messageId, matchId, ai.version, lease)
      .run();
  } catch {
    fail(
      503,
      "The instance AI could not reply. Your message is saved; retry to request a reply.",
    );
  } finally {
    await env.DB.prepare(
      "DELETE FROM hosted_replies WHERE message_id=? AND lease=?",
    )
      .bind(messageId, lease)
      .run();
  }
}
