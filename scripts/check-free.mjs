import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { cfBin } from "./cf-bin.mjs";
const config = JSON.parse(await readFile("deployment.json", "utf8"));
const fail = (message) => {
  throw new Error(`Free-only deployment refused: ${message}`);
};
if (config.worker.name !== "estrogen-dating") fail("unexpected Worker name");
const workerKeys = new Set([
  "name",
  "compatibilityDate",
  "assets",
  "domains",
  "workersDev",
  "previewUrls",
  "observability",
  "unsafe",
  "env",
]);
for (const key of Object.keys(config.worker))
  if (!workerKeys.has(key)) fail(`unreviewed Worker option: ${key}`);
if (
  JSON.stringify(config.worker.unsafe) !==
  JSON.stringify({ metadata: { usage_model: "standard" } })
)
  fail("unexpected upload metadata");
if (Object.keys(config).some((key) => !["accountId", "worker"].includes(key)))
  fail("unexpected deployment resources");
const accountCache = JSON.parse(
  await readFile(".cloudflare/cache/cloudflare-account.json", "utf8"),
);
if (accountCache.account.id !== config.accountId)
  fail("CLI account does not match deployment account");
const allowed = new Set(["d1", "assets", "text", "secret"]);
for (const [name, binding] of Object.entries(config.worker.env))
  if (!allowed.has(binding.type))
    fail(`forbidden binding ${name}: ${binding.type}`);
if (
  Object.values(config.worker.env).filter((b) => b.type === "d1").length !== 1
)
  fail("exactly one D1 database is required");
if (config.worker.env.DB.name !== "estrogen-dating-db")
  fail("unexpected database");
if (
  config.worker.tailConsumers ||
  config.worker.exports ||
  config.worker.triggers ||
  config.worker.placement
)
  fail("unexpected additional services");
if (config.worker.observability?.enabled !== false)
  fail("observability must be off");
const cf = cfBin;
const subscriptions = JSON.parse(
  execFileSync(cf, ["accounts", "subscriptions", "get"], { encoding: "utf8" }),
);
if (!Array.isArray(subscriptions))
  fail("could not verify account subscriptions");
// Fail closed for any active paid account subscription, including Workers Paid.
if (
  subscriptions.some(
    (s) =>
      s.state !== "Expired" &&
      s.state !== "Canceled" &&
      (Number(s.price) > 0 || /workers|standard|paid/i.test(JSON.stringify(s))),
  )
)
  fail("account has a paid or Workers subscription");
console.log(
  "Verified: no paid account subscriptions; only D1, static assets and configuration bindings. Never upgrade this account for this app.",
);
