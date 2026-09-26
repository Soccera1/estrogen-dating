import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import type { App } from "./types";

export const random = () =>
  crypto.randomUUID().replaceAll("-", "") +
  crypto.randomUUID().replaceAll("-", "");
export const sha256 = async (text: string) => {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  );
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
};
export function fail(
  status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 429 | 503,
  message: string,
): never {
  throw new HTTPException(status, { message });
}
export async function readBytes(request: Request, limit: number) {
  if (Number(request.headers.get("content-length")) > limit)
    fail(413, "Upload is too large.");
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      fail(413, "Upload is too large.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
export async function jsonBody(
  c: Context<App>,
): Promise<Record<string, unknown>> {
  if (!c.req.header("content-type")?.startsWith("application/json"))
    fail(415, "Use application/json.");
  try {
    const value = JSON.parse(
      new TextDecoder().decode(await readBytes(c.req.raw, 16384)),
    );
    if (!value || typeof value !== "object" || Array.isArray(value))
      fail(400, "Expected a JSON object.");
    return value;
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    fail(400, "Invalid JSON.");
  }
}
export function string(value: unknown, field: string, max: number, min = 0) {
  if (
    typeof value !== "string" ||
    value.trim().length < min ||
    value.length > max
  )
    fail(400, `${field} must be ${min}–${max} characters.`);
  return value.trim();
}
export async function rate(
  c: Context<App>,
  key: string,
  max = 60,
  seconds = 60,
) {
  const now = Math.floor(Date.now() / 1000);
  const row = await c.env.DB.prepare(
    `INSERT INTO rate_limits(key,count,expires_at) VALUES(?,1,?)
    ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires_at<=? THEN 1 ELSE count+1 END,
    expires_at=CASE WHEN expires_at<=? THEN excluded.expires_at ELSE expires_at END RETURNING count`,
  )
    .bind(key, now + seconds, now, now)
    .first<{ count: number }>();
  if (!row || row.count > max) {
    c.header("Retry-After", String(seconds));
    fail(429, "Please slow down and try again.");
  }
}
export function cursor(c: Context<App>, numeric = false) {
  const value = c.req.query("cursor") || (numeric ? "0" : "");
  if (value.length > 100 || (numeric && !/^\d{1,15}$/.test(value)))
    fail(400, "Invalid cursor.");
  return numeric ? Number(value) : value;
}
