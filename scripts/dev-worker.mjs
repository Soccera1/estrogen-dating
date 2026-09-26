import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readFile, readdir } from "node:fs/promises";
import { loadDeployment } from "./deployment-config.mjs";
const config = loadDeployment();
const mf = new Miniflare({
  ...convertV4MiniflareOptions({
    modules: true,
    scriptPath: "dist/worker/index.js",
    compatibilityDate: "2026-09-25",
    port: 8787,
    d1Databases: { DB: "local-estrogen-dating" },
    bindings: {
      APP_ORIGIN: "http://localhost:5173",
      HRTID_ISSUER: config.worker.env.HRTID_ISSUER.value,
      HRTID_CLIENT_ID: "",
    },
  }),
  resourcePersistencePath: ".cloudflare/local-d1",
});
const db = await mf.getD1Database("DB");
await db.exec(
  "CREATE TABLE IF NOT EXISTS d1_migrations (name TEXT PRIMARY KEY)",
);
for (const name of (await readdir("migrations"))
  .filter((f) => f.endsWith(".sql"))
  .sort()) {
  if (
    await db
      .prepare("SELECT name FROM d1_migrations WHERE name=?")
      .bind(name)
      .first()
  )
    continue;
  const legacy =
    name === "0001_initial.sql" &&
    (await db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='accounts'",
      )
      .first());
  if (!legacy) {
    const sql = await readFile(`migrations/${name}`, "utf8");
    await db.exec(sql.replace(/--[^\n]*/g, "").replaceAll("\n", " "));
  }
  await db
    .prepare("INSERT INTO d1_migrations(name) VALUES(?)")
    .bind(name)
    .run();
}
console.log(
  `Local API ready at ${await mf.ready}. Local login is intentionally disabled; tests seed isolated sessions.`,
);
