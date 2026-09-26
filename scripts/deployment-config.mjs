import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export function deploymentPath(env = process.env) {
  return resolve(
    env.DEPLOYMENT_CONFIG ||
      (existsSync("deployment.local.json")
        ? "deployment.local.json"
        : "deployment.json"),
  );
}
export function loadDeployment(path = deploymentPath()) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function validateDeployment(config, { forceFree = false } = {}) {
  const fail = (message) => {
    throw new Error(`Deployment refused: ${message}`);
  };
  const mode = config.billingMode ?? "free";
  if (!["free", "paid"].includes(mode))
    fail('billingMode must be "free" or "paid"');
  if (forceFree && mode !== "free")
    fail("check:free requires billingMode free");
  if (
    Object.keys(config).some(
      (k) => !["accountId", "billingMode", "worker"].includes(k),
    )
  )
    fail("unexpected deployment resources");
  if (!/^[a-f0-9]{32}$/i.test(config.accountId))
    fail("set your Cloudflare accountId");
  const w = config.worker;
  if (!w || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(w.name))
    fail("invalid Worker name");
  const keys = new Set([
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
  for (const key of Object.keys(w))
    if (!keys.has(key)) fail(`unreviewed Worker option: ${key}`);
  if (
    JSON.stringify(w.unsafe) !==
    JSON.stringify({ metadata: { usage_model: "standard" } })
  )
    fail("unexpected upload metadata");
  if (
    w.observability?.enabled !== false ||
    Object.keys(w.observability).length !== 1
  )
    fail("observability must be off");
  if (w.previewUrls !== false) fail("preview URLs must be disabled");
  if (
    JSON.stringify(w.assets) !==
    JSON.stringify({
      notFoundHandling: "single-page-application",
      runWorkerFirst: ["/api/*", "/auth/*"],
    })
  )
    fail("preserve static asset routing");
  const bindings = w.env ?? {};
  const allowed = new Set(["d1", "assets", "text", "secret"]);
  for (const [name, binding] of Object.entries(bindings))
    if (!allowed.has(binding?.type)) fail(`forbidden binding ${name}`);
  if (
    Object.values(bindings).filter((b) => b.type === "d1").length !== 1 ||
    bindings.DB?.type !== "d1"
  )
    fail("exactly one D1 database bound as DB is required");
  if (
    !bindings.DB.name ||
    !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(bindings.DB.id)
  )
    fail("set your D1 name and database ID");
  if (bindings.ASSETS?.type !== "assets") fail("ASSETS binding is required");
  const origin = bindings.APP_ORIGIN?.value;
  let url;
  try {
    url = new URL(origin);
  } catch {
    fail("APP_ORIGIN must be an HTTPS origin");
  }
  if (
    bindings.APP_ORIGIN?.type !== "text" ||
    url.protocol !== "https:" ||
    url.origin !== origin ||
    /YOUR_|PLACEHOLDER/i.test(origin)
  )
    fail(
      "APP_ORIGIN must be your exact HTTPS origin, without a trailing slash",
    );
  if (!Array.isArray(w.domains) || typeof w.workersDev !== "boolean")
    fail("set domains and workersDev");
  if (
    !w.domains.includes(url.hostname) &&
    !(
      w.workersDev &&
      url.hostname.endsWith(".workers.dev") &&
      url.hostname.startsWith(`${w.name}.`)
    )
  )
    fail(
      "APP_ORIGIN must match a configured domain or this Worker's workers.dev address",
    );
  for (const name of ["HRTID_CLIENT_ID", "HRTID_ISSUER"]) {
    if (
      bindings[name]?.type !== "text" ||
      !bindings[name].value ||
      /YOUR_|PLACEHOLDER/.test(bindings[name].value)
    )
      fail(`set ${name}`);
  }
  try {
    if (new URL(bindings.HRTID_ISSUER.value).protocol !== "https:")
      fail("HRTID_ISSUER must use HTTPS");
  } catch {
    fail("HRTID_ISSUER must use HTTPS");
  }
  if (
    ["AI_ENDPOINT", "AI_MODEL", "AI_API_KEY"].some((name) => name in bindings)
  ) {
    let endpoint;
    try {
      endpoint = new URL(bindings.AI_ENDPOINT?.value);
    } catch {
      fail("set an HTTPS AI_ENDPOINT");
    }
    if (
      bindings.AI_ENDPOINT?.type !== "text" ||
      endpoint.protocol !== "https:" ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    )
      fail("AI_ENDPOINT must be HTTPS without credentials, query or fragment");
    if (
      bindings.AI_MODEL?.type !== "text" ||
      !bindings.AI_MODEL.value?.trim() ||
      bindings.AI_MODEL.value.length > 200
    )
      fail("set AI_MODEL as a text binding");
    if (
      bindings.AI_API_KEY?.type !== "secret" ||
      Object.keys(bindings.AI_API_KEY).some((key) => key !== "type")
    )
      fail(
        "AI_API_KEY must be a secret binding without a value in configuration",
      );
  }
  return mode;
}

export function validateSubscriptions(subscriptions) {
  if (!Array.isArray(subscriptions))
    throw new Error("Could not verify account subscriptions");
  if (
    subscriptions.some(
      (s) =>
        !s ||
        typeof s !== "object" ||
        (!["Expired", "Canceled"].includes(s.state) &&
          (s.price === undefined ||
            !Number.isFinite(Number(s.price)) ||
            Number(s.price) > 0 ||
            /workers|standard|paid/i.test(JSON.stringify(s)))),
    )
  ) {
    throw new Error(
      'Free-only deployment refused: paid or unverified account subscription. Opt in with billingMode: "paid" to permit Cloudflare charges.',
    );
  }
}

export function deploymentEnv(config, path = deploymentPath()) {
  if (
    process.env.CLOUDFLARE_ACCOUNT_ID &&
    process.env.CLOUDFLARE_ACCOUNT_ID !== config.accountId
  )
    throw new Error(
      "CLOUDFLARE_ACCOUNT_ID does not match deployment accountId",
    );
  return {
    ...process.env,
    DEPLOYMENT_CONFIG: path,
    CLOUDFLARE_ACCOUNT_ID: config.accountId,
  };
}
