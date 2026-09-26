// Local V8 sampling diagnostics. Scheduling/runtime overhead differs from the edge CPU meter.
// Actual Cloudflare Free measurements and method are documented in docs/OPERATIONS.md.
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
const origin = "https://edating.soccera.uk";
const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    scriptPath: "dist/worker/index.js",
    compatibilityDate: "2026-09-25",
    inspectorPort: 0,
    d1Databases: ["DB"],
    bindings: { APP_ORIGIN: origin },
  }),
);
const db = await mf.getD1Database("DB");
await db.exec(
  (await readFile("migrations/0001_initial.sql", "utf8"))
    .replace(/--[^\n]*/g, "")
    .replaceAll("\n", " "),
);
await db.batch([
  db.prepare("INSERT INTO accounts(id,subject) VALUES('cpu','cpu')"),
  db.prepare(
    "INSERT INTO profiles(id,account_id,kind,name,onboarded,discoverable) VALUES('cpu','cpu','human','CPU fixture',1,0)",
  ),
  db
    .prepare(
      "INSERT INTO sessions(hash,account_id,csrf,expires_at) VALUES(?,'cpu','csrf',unixepoch()+3600)",
    )
    .bind(createHash("sha256").update("cpu-session").digest("base64url")),
]);
const small = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==",
  "base64",
);
const png = Buffer.alloc(524288, 120);
small.copy(png, 0, 0, small.length - 12);
const offset = small.length - 12,
  length = 524288 - small.length - 12;
png.writeUInt32BE(length, offset);
png.write("tEXt", offset + 4);
png.write("Pad\0", offset + 8);
let crc = 0xffffffff;
for (let i = offset + 4; i < offset + 8 + length; i++) {
  crc ^= png[i];
  for (let bit = 0; bit < 8; bit++)
    crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
}
png.writeUInt32BE((crc ^ 0xffffffff) >>> 0, offset + 8 + length);
small.copy(png, 524288 - 12, small.length - 12);
const headers = {
  Cookie: "__Host-ed-session=cpu-session",
  "X-CSRF-Token": "csrf",
  "X-Profile-ID": "cpu",
  Origin: origin,
};
async function upload() {
  const r = await mf.dispatchFetch(origin + "/api/v1/profile/avatar", {
    method: "PUT",
    headers: { ...headers, "Content-Type": "image/png" },
    body: png,
  });
  assert.equal(r.status, 200, await r.text());
}
async function download() {
  const r = await mf.dispatchFetch(origin + "/api/v1/profiles/cpu/avatar", {
    headers,
  });
  assert.equal(r.status, 200);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), png);
}
let ws;
try {
  await upload();
  await download();
  const url = await mf.getInspectorURL();
  const targets = await (
    await fetch(String(url).replace("ws:", "http:") + "json")
  ).json();
  ws = new WebSocket(
    targets.find((target) => target.id.startsWith("core:user:"))
      .webSocketDebuggerUrl,
  );
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id) {
      const [resolve, reject] = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(msg.error) : resolve(msg.result);
    }
  };
  const command = (method, params = {}) =>
    new Promise((resolve, reject) => {
      pending.set(++id, [resolve, reject]);
      ws.send(JSON.stringify({ id, method, params }));
    });
  await command("Profiler.enable");
  await command("Profiler.setSamplingInterval", { interval: 100 });
  for (const [name, operation] of [
    ["upload", upload],
    ["download", download],
  ]) {
    const samples = [];
    for (let n = 0; n < 5; n++) {
      await command("Profiler.start");
      await operation();
      const { profile } = await command("Profiler.stop");
      const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
      let active = 0;
      for (let i = 0; i < profile.samples.length; i++) {
        const fn = nodes.get(profile.samples[i]).callFrame.functionName;
        if (!["(idle)", "(program)", "(root)"].includes(fn))
          active += profile.timeDeltas[i];
      }
      samples.push(active / 1000);
    }
    console.log(
      `512 KB ${name} local V8 samples (ms; not edge CPU): ${samples.map((n) => n.toFixed(2)).join(", ")}`,
    );
    // Edge CPU acceptance is measured separately on Cloudflare; see OPERATIONS.md.
  }
  const row = await db
    .prepare(
      "SELECT typeof(bytes) AS type,size FROM avatars WHERE profile_id='cpu'",
    )
    .first();
  assert.deepEqual(row, { type: "blob", size: 524288 });
} finally {
  ws?.close();
  await mf.dispose();
}
