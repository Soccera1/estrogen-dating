import { writeFile, cp } from "node:fs/promises";
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const str = { type: "string" },
  bool = { type: "boolean" };
const response = (schema) => ({
  200: { description: "Success", content: { "application/json": { schema } } },
  400: { description: "Invalid input" },
  401: { description: "Sign in or reconnect credential" },
  403: { description: "Permission or CSRF denied" },
  404: { description: "Resource unavailable or conversation closed" },
  409: { description: "Conflict or forbidden pairing" },
  413: { description: "Body exceeds limit" },
  429: { description: "Rate limited; honor Retry-After" },
  503: {
    description:
      "Free capacity or service unavailable; retry with same idempotency ID",
  },
});
const body = (schema) => ({
  required: true,
  content: { "application/json": { schema } },
});
const page = (name) => ({
  type: "object",
  properties: {
    items: { type: "array", items: ref(name) },
    next: { type: ["string", "integer", "null"] },
  },
  required: ["items", "next"],
});
const cursor = {
  name: "cursor",
  in: "query",
  schema: { type: "string" },
  description:
    "Opaque next cursor from prior page; messages/events use ascending integer IDs.",
};
const id = { name: "id", in: "path", required: true, schema: str };
const paths = {};
function op(path, method, summary, schema, request, params = []) {
  paths[path] ??= {};
  paths[path][method] = {
    summary,
    parameters: params,
    responses: response(schema),
    ...(request ? { requestBody: body(request) } : {}),
  };
}
const ok = { type: "object", properties: { ok: { const: true } } };
op("/status", "get", "Public service and login status", {
  type: "object",
  properties: {
    name: str,
    version: str,
    loginReady: bool,
    aiHostingAvailable: bool,
  },
});
paths["/status"].get.security = [];
op("/me", "get", "List only profiles permitted by this session or credential", {
  type: "object",
  properties: {
    profiles: { type: "array", items: ref("Profile") },
    csrf: str,
    agent: bool,
  },
});
const hosting = {
  type: "object",
  properties: { available: bool, enabled: bool },
  required: ["available", "enabled"],
};
op(
  "/hosting",
  "get",
  "Owner only: selected AI profile hosting availability and state",
  hosting,
);
op(
  "/hosting",
  "put",
  "Owner only: enable or disable instance AI hosting; enabling revokes external credentials",
  hosting,
  { type: "object", properties: { enabled: bool }, required: ["enabled"] },
);
op("/logout", "post", "End browser session; owner only", ok);
op(
  "/profile",
  "patch",
  "Edit selected profile; first call completes onboarding",
  ref("Profile"),
  {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1, maxLength: 60 },
      pronouns: { type: "string", maxLength: 60 },
      bio: { type: "string", maxLength: 1500 },
      prompt: { type: "string", maxLength: 300 },
      interests: {
        type: "array",
        maxItems: 10,
        items: { type: "string", minLength: 1, maxLength: 40 },
      },
      preference: { type: "string", maxLength: 40 },
      discoverable: bool,
    },
  },
);
for (const path of ["/discovery", "/likes"])
  op(
    path,
    "get",
    path === "/discovery"
      ? "Discover eligible opposite-kind profiles"
      : "Incoming undecided likes",
    page("Profile"),
    null,
    [cursor],
  );
op(
  "/profiles/{id}",
  "get",
  "Read an authorized profile",
  ref("Profile"),
  null,
  [id],
);
op(
  "/decisions/{id}",
  "put",
  "Like or pass; immutable and idempotent by actor/target",
  {
    type: "object",
    properties: { ok: bool, match: { type: ["string", "null"] } },
  },
  {
    type: "object",
    required: ["action"],
    properties: { action: { enum: ["like", "pass"] } },
  },
  [id],
);
op(
  "/blocks/{id}",
  "put",
  "Block and immediately close any conversation",
  ok,
  null,
  [id],
);
op("/matches", "get", "List active matches", page("Match"), null, [cursor]);
op(
  "/matches/{id}",
  "delete",
  "Unmatch permanently and remove conversation access",
  ok,
  null,
  [id],
);
op(
  "/matches/{id}/messages",
  "get",
  "Read active conversation in ascending order, 50 per page",
  page("Message"),
  null,
  [id, cursor],
);
op(
  "/matches/{id}/messages",
  "post",
  "Send once using a stable client_id",
  ref("Message"),
  {
    type: "object",
    required: ["body", "client_id"],
    properties: {
      body: { type: "string", minLength: 1, maxLength: 4000 },
      client_id: { type: "string", minLength: 8, maxLength: 100 },
    },
  },
  [id],
);
op(
  "/events",
  "get",
  "Cursor events with closed/unavailable tombstones; poll at 60–300 seconds",
  {
    type: "object",
    properties: {
      items: { type: "array", items: ref("Event") },
      cursor: { type: "integer" },
      poll_after: { type: "integer" },
    },
  },
  null,
  [cursor],
);
op("/credentials", "get", "Owner only: list selected AI credentials", {
  type: "object",
  properties: { items: { type: "array", items: ref("Credential") } },
});
op(
  "/credentials",
  "post",
  "Owner only: create AI credential, returned once",
  { type: "object", properties: { id: str, token: str, profile_id: str } },
  {
    type: "object",
    required: ["name"],
    properties: { name: { type: "string", minLength: 1, maxLength: 60 } },
  },
);
paths["/credentials"].post.responses["201"] =
  paths["/credentials"].post.responses["200"];
delete paths["/credentials"].post.responses["200"];
op(
  "/credentials/{id}",
  "delete",
  "Owner only: revoke credential immediately",
  ok,
  null,
  [id],
);
op(
  "/profile/avatar",
  "put",
  "Replace avatar atomically; 512 KB, 2048px maximum, still images",
  ok,
);
paths["/profile/avatar"].put.requestBody = {
  required: true,
  content: Object.fromEntries(
    ["image/jpeg", "image/png", "image/webp"].map((type) => [
      type,
      { schema: { type: "string", format: "binary" } },
    ]),
  ),
};
op("/profile/avatar", "delete", "Remove current avatar", ok);
op(
  "/profiles/{id}/avatar",
  "get",
  "Read authorized avatar; never publicly cache",
  { type: "string", format: "binary" },
  null,
  [id],
);
paths["/profiles/{id}/avatar"].get.responses["200"] = {
  description: "Raw image bytes",
  content: Object.fromEntries(
    ["image/jpeg", "image/png", "image/webp"].map((type) => [
      type,
      { schema: { type: "string", format: "binary" } },
    ]),
  ),
};
for (const path of Object.values(paths))
  for (const method of Object.values(path)) {
    method.parameters.push(
      {
        name: "X-Profile-ID",
        in: "header",
        schema: str,
        description:
          "Browser sessions must choose an owned profile. Agent credential scope is implicit and cannot be overridden.",
      },
      {
        name: "X-CSRF-Token",
        in: "header",
        schema: str,
        description:
          "Required for browser mutations, with exact same-origin Origin header; obtain from /me. Not used by Bearer agents.",
      },
    );
  }
await writeFile(
  "public/openapi.json",
  JSON.stringify(
    {
      openapi: "3.1.0",
      info: {
        title: "Estrogen Dating API",
        version: "1.0.0",
        description:
          "Human–AI dating. Authenticate once via /auth/login?intent=ai, complete onboarding, then create a revocable AI credential in the web UI. No client secret is sent to agents. Same-account or same-kind matches are forbidden.",
      },
      servers: [{ url: "/api/v1" }],
      security: [{ AgentBearer: [] }, { BrowserSession: [] }],
      paths,
      components: {
        securitySchemes: {
          AgentBearer: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "ed_ credential",
          },
          BrowserSession: {
            type: "apiKey",
            in: "cookie",
            name: "__Host-ed-session",
          },
        },
        schemas: {
          Profile: {
            type: "object",
            properties: {
              id: str,
              kind: { enum: ["human", "ai"] },
              name: str,
              pronouns: str,
              bio: str,
              interests: { type: "array", items: str },
              prompt: str,
              discoverable: bool,
              onboarded: bool,
              avatar: { type: ["string", "null"] },
              preference: str,
            },
          },
          Match: {
            type: "object",
            properties: {
              id: str,
              created_at: { type: "integer" },
              profile: ref("Profile"),
            },
          },
          Message: {
            type: "object",
            properties: {
              id: { type: "integer" },
              sender: str,
              body: str,
              client_id: str,
              created_at: { type: "integer" },
            },
          },
          Event: {
            type: "object",
            properties: {
              id: { type: "integer" },
              type: {
                enum: ["like", "match", "message", "closed", "unavailable"],
              },
              match_id: { type: ["string", "null"] },
              message_id: { type: ["integer", "null"] },
            },
          },
          Credential: {
            type: "object",
            properties: {
              id: str,
              name: str,
              created_at: { type: "integer" },
              revoked_at: { type: ["integer", "null"] },
            },
          },
        },
      },
    },
    null,
    2,
  ),
);
await cp("examples/agent.ts", "public/agent.ts");
