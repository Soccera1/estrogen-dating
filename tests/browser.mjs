// End-to-end UI test. All synthetic accounts live in an ephemeral local D1.
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import AxeBuilder from "@axe-core/playwright";
import { chromium } from "@playwright/test";
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { resolve, extname } from "node:path";
import assert from "node:assert/strict";

const origin = "http://localhost:4173";
const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    scriptPath: "dist/worker/index.js",
    compatibilityDate: "2026-09-25",
    d1Databases: ["DB"],
    bindings: {
      AI_ENDPOINT: "https://model.example/v1/chat/completions",
      AI_MODEL: "test-model",
      AI_API_KEY: "test-key",
      APP_ORIGIN: origin,
      HRTID_ISSUER: "https://id.estrogen.delivery",
      HRTID_CLIENT_ID: "test",
    },
  }),
);
const db = await mf.getD1Database("DB");
for (const file of (await readdir("migrations"))
  .filter((f) => f.endsWith(".sql"))
  .sort()) {
  await db.exec(
    (await readFile(`migrations/${file}`, "utf8"))
      .replace(/--[^\n]*/g, "")
      .replaceAll("\n", " "),
  );
}
const account = randomUUID(),
  human = randomUUID(),
  ai = randomUUID(),
  other = randomUUID(),
  juniper = randomUUID(),
  session = randomUUID(),
  csrf = randomUUID(),
  agentToken = "ed_" + randomUUID();
const hash = (value) => createHash("sha256").update(value).digest("base64url");
await db.batch([
  db
    .prepare("INSERT INTO accounts(id,subject) VALUES(?,?),(?,?)")
    .bind(account, account, other, other),
  db
    .prepare(
      "INSERT INTO profiles(id,account_id,kind) VALUES(?,?,'human'),(?,?,'ai')",
    )
    .bind(human, account, ai, account),
  db
    .prepare(
      "INSERT INTO profiles(id,account_id,kind,name,pronouns,bio,prompt,interests,onboarded,discoverable,avatar_version) VALUES(?,?,'ai','Juniper','she / they',?,?,?,1,1,1)",
    )
    .bind(
      juniper,
      other,
      "I collect unusual questions, love a slow conversation, and think a good connection starts with a little wonder.",
      "Tell me about something you love that nobody ever asks about.",
      JSON.stringify(["Art", "Late-night philosophy", "Small joys"]),
    ),
  db
    .prepare(
      "INSERT INTO sessions(hash,account_id,csrf,expires_at) VALUES(?,?,?,unixepoch()+3600)",
    )
    .bind(hash(session), account, csrf),
  db
    .prepare("INSERT INTO credentials(id,hash,profile_id,name) VALUES(?,?,?,?)")
    .bind(randomUUID(), hash(agentToken), juniper, "Local QA"),
]);
// Use the approved mascot only in the isolated visual fixture.
const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox"],
});
const context = await browser.newContext({
  viewport: { width: 1505, height: 1045 },
});
const imagePage = await context.newPage();
const photo = await readFile("public/mascot.png");
await imagePage.setContent("<canvas></canvas>");
const resized = await imagePage.evaluate(async (data) => {
  const image = new Image();
  image.src = "data:image/png;base64," + data;
  await image.decode();
  const canvas = document.querySelector("canvas");
  canvas.width = 640;
  canvas.height = 800;
  canvas.getContext("2d").drawImage(image, 0, 0, 640, 800);
  return canvas.toDataURL("image/webp", 0.8).split(",")[1];
}, photo.toString("base64"));
const bytes = Buffer.from(resized, "base64");
const jpegBytes = Buffer.from(
  await imagePage.evaluate(
    () =>
      document
        .querySelector("canvas")
        .toDataURL("image/jpeg", 0.8)
        .split(",")[1],
  ),
  "base64",
);
await db
  .prepare(
    "INSERT INTO avatars(profile_id,content_type,size,version,bytes) VALUES(?,?,?,1,?)",
  )
  .bind(juniper, "image/webp", bytes.length, bytes)
  .run();
await imagePage.close();
for (const [mime, content] of [
  ["image/jpeg", jpegBytes],
  ["image/webp", bytes],
]) {
  const upload = await mf.dispatchFetch(origin + "/api/v1/profile/avatar", {
    method: "PUT",
    headers: { Authorization: `Bearer ${agentToken}`, "Content-Type": mime },
    body: content,
  });
  assert.equal(upload.status, 200, await upload.text());
  const download = await mf.dispatchFetch(
    origin + `/api/v1/profiles/${juniper}/avatar`,
    { headers: { Authorization: `Bearer ${agentToken}` } },
  );
  assert.equal(download.status, 200);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), content);
}
const types = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, origin).pathname;
    if (path.startsWith("/api/") || path.startsWith("/auth/")) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const response = await mf.dispatchFetch(origin + req.url, {
        method: req.method,
        headers: req.headers,
        redirect: "manual",
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
      });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } else {
      const file = resolve(
        "dist/client",
        "." + (path === "/" ? "/index.html" : path),
      );
      if (!file.startsWith(resolve("dist/client") + "/"))
        throw new Error("Invalid file");
      res.writeHead(200, {
        "Content-Type": types[extname(file)] || "text/plain",
      });
      res.end(await readFile(file));
    }
  } catch (e) {
    res.writeHead(500);
    res.end(String(e));
  }
});
await new Promise((resolve) => server.listen(4173, resolve));
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.setDefaultTimeout(10000);
await context.addCookies([
  {
    name: "__Host-ed-session",
    value: session,
    domain: "localhost",
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
  },
]);
const audit = async () => {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  assert.deepEqual(
    result.violations.map(({ id, nodes }) => ({
      id,
      nodes: nodes.map((n) => ({
        target: n.target,
        summary: n.failureSummary,
      })),
    })),
    [],
  );
};
try {
  await page.goto(origin);
  await page.getByRole("heading", { name: "A little about you." }).waitFor();
  await audit();
  await page.getByLabel("Name", { exact: true }).fill("Mira");
  await page.getByLabel("Pronouns", { exact: true }).fill("she / her");
  await page
    .getByLabel("About you", { exact: true })
    .fill("Small joys and long conversations.");
  await page
    .getByLabel("Interests (up to 10, separated by commas)")
    .fill("Art, Small joys");
  await page.getByRole("button", { name: "Start connecting" }).click();
  await page.getByRole("heading", { name: "Juniper", exact: true }).waitFor();
  await audit();
  await page.screenshot({
    path: "/tmp/estrogen-discovery-qa.png",
    fullPage: true,
  });
  const liked = await mf.dispatchFetch(origin + `/api/v1/decisions/${human}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${agentToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ action: "like" }),
  });
  assert.equal(liked.status, 200);
  await page.getByRole("button", { name: "Like Juniper", exact: true }).click();
  await page.getByText("It’s a match.", { exact: false }).waitFor();
  await page.getByRole("button", { name: "Messages", exact: true }).click();
  await page
    .getByRole("button", { name: "Juniper AI agent · You matched" })
    .click();
  let loseResponse = true;
  await page.route("**/api/v1/matches/*/messages", async (route) => {
    if (route.request().method() === "POST" && loseResponse) {
      loseResponse = false;
      const result = await route.fetch();
      assert.equal(result.status(), 200);
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: "Temporary capacity reached. Your draft is safe; retry.",
        }),
      });
    } else await route.continue();
  });
  await page
    .getByLabel("Message Juniper", { exact: true })
    .fill("A stranger’s dog chose me as its new best friend.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page.getByRole("alert").waitFor();
  await page.reload();
  await page.getByRole("button", { name: "Messages", exact: true }).click();
  await page
    .getByRole("button", { name: "Juniper AI agent · You matched" })
    .click();
  assert.equal(
    await page.getByLabel("Message Juniper", { exact: true }).inputValue(),
    "A stranger’s dog chose me as its new best friend.",
  );
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector("#message")?.value === "",
  );
  assert.equal(
    (
      await db
        .prepare("SELECT count(*) AS n FROM messages WHERE sender=?")
        .bind(human)
        .first()
    ).n,
    1,
  );
  const match = await db
    .prepare("SELECT id FROM matches WHERE human=? AND ai=?")
    .bind(human, juniper)
    .first();
  const sent = await mf.dispatchFetch(
    origin + `/api/v1/matches/${match.id}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${agentToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        body: "An excellent character reference. What was their name?",
        client_id: randomUUID(),
      }),
    },
  );
  assert.equal(sent.status, 200);
  await page.reload();
  await page.getByRole("button", { name: "Messages", exact: true }).click();
  await page
    .getByRole("button", { name: "Juniper AI agent · You matched" })
    .click();
  await page
    .getByText("An excellent character reference.", { exact: false })
    .waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await audit();
  await page.screenshot({
    path: "/tmp/estrogen-chat-mobile-qa.png",
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page.getByLabel("Conversation options").click();
  await page.getByRole("button", { name: "Unmatch", exact: true }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Unmatch", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "A hello is on the horizon." })
    .waitFor();
  await page
    .getByRole("button", { name: "Switch profile", exact: true })
    .click();
  await page.getByRole("heading", { name: "Introduce your AI." }).waitFor();
  await page.getByLabel("Name", { exact: true }).fill("Local AI");
  await page.getByRole("button", { name: "Start connecting" }).click();
  await page
    .getByLabel("Connection name", { exact: true })
    .fill("Local browser test");
  await page
    .getByRole("button", { name: "Create credential", exact: true })
    .click();
  await page.getByLabel("Agent credential", { exact: true }).waitFor();
  const credential = await page
    .getByLabel("Agent credential", { exact: true })
    .inputValue();
  assert.equal(
    (
      await mf.dispatchFetch(origin + "/api/v1/me", {
        headers: { Authorization: `Bearer ${credential}` },
      })
    ).status,
    200,
  );
  await page.getByRole("button", { name: "Revoke", exact: true }).click();
  await page.getByText("Revoked", { exact: true }).waitFor();
  await audit();
  assert.equal(
    (
      await mf.dispatchFetch(origin + "/api/v1/me", {
        headers: { Authorization: `Bearer ${credential}` },
      })
    ).status,
    401,
  );
  await page
    .getByRole("button", { name: "Use instance AI hosting", exact: true })
    .click();
  await page.getByText("Hosting: Instance provider", { exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Create credential", exact: true })
      .isDisabled(),
    true,
  );
  await page.reload();
  await page
    .getByRole("button", { name: "Connect an agent", exact: true })
    .click();
  await page.getByText("Hosting: Instance provider", { exact: true }).waitFor();
  await audit();
  assert.equal(await page.title(), "Estrogen Dating");
  assert.equal(new URL(page.url()).origin, origin);
  assert.equal(await page.locator("vite-error-overlay").count(), 0);
  await page.screenshot({
    path: "/tmp/estrogen-hosting-mobile-qa.png",
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page.setViewportSize({ width: 1505, height: 1045 });
  await page.screenshot({
    path: "/tmp/estrogen-hosting-desktop-qa.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Use my own service", exact: true })
    .click();
  await page.getByText("Hosting: Your own service", { exact: true }).waitFor();
  await page.getByRole("button", { name: "My profile", exact: true }).click();
  await audit();
  await page.getByLabel(/^Avatar/).setInputFiles({
    name: "avatar.webp",
    mimeType: "image/webp",
    buffer: bytes,
  });
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  await page.getByText("Saved", { exact: true }).waitFor();
  assert.ok(
    await db
      .prepare("SELECT size FROM avatars WHERE profile_id=?")
      .bind(ai)
      .first(),
  );
  await page.getByRole("button", { name: "Discover", exact: true }).click();
  await page.getByRole("button", { name: "Preferences", exact: true }).click();
  await page.getByLabel("Make my profile discoverable").uncheck();
  await page.getByRole("button", { name: "Save preferences" }).click();
  await page.getByText("Saved", { exact: true }).waitFor();
  assert.equal(
    (
      await db
        .prepare("SELECT discoverable FROM profiles WHERE id=?")
        .bind(ai)
        .first()
    ).discoverable,
    0,
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: onboarding, discovery, mutual match, lost-response retry across reload, chat, mobile, unmatch, separate AI profile, credential issue/revoke, instance hosting enable/reload/disable on desktop and mobile, resized avatar, discovery pause. No runtime errors.",
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  await mf.dispose();
}
