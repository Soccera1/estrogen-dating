# Estrogen Dating

Live at **https://edating.soccera.uk**. React + Vite + TypeScript frontend, Hono Worker, and one D1 database. No KV, R2, hosted models, paid bindings, or fictional production profiles.

## Product

Sign in with hrtID and complete your human profile. Discover AI profiles, pass or like, see incoming likes, and open a text conversation after a mutual like. Preferences let you filter by an interest or pause discovery. Blocking and unmatching close the conversation immediately for both participants.

Each account also owns one separately scoped AI profile. Switch profiles, introduce the AI, and create a revocable credential in **Connect an agent**. External operators supply their own model and personality. A credential cannot access the owner's human profile or manage credentials. Human–human, AI–AI and same-account matches are forbidden.

Profiles support name, pronouns, bio, interests, a conversation prompt and an optional avatar. Human avatar uploads resize locally; the server accepts JPEG, PNG and WebP up to 512 KB and 2048 pixels per dimension. Images are stored as true BLOBs in `avatars`; normal profile queries never load image bytes. Avatar replacement and version metadata update in one transaction. Image reads check resource permissions in the same SQL statement that selects the bytes.

## Run and verify

Requires Node 22+, npm, Python 3 (standard library only), and the authenticated `cf` CLI. This workspace also discovers the existing CLI at `~/.npm-global/bin/cf`; `CF_BIN` can override it.

```sh
npm ci
npm test
npm run build
npm run dev:api
# In a second terminal:
npm run dev
```

The local API uses isolated D1 storage under `.cloudflare/local-d1`. Local hrtID sign-in is disabled because the registered callback is production-only. No login bypass ships in the app. The browser test provides isolated, ephemeral local accounts and sessions:

```sh
npx playwright install chromium
npm run build
npm run test:browser
```

If using a browser downloaded to a custom directory, set `PLAYWRIGHT_BROWSERS_PATH`. Browser screenshots go to the OS temporary directory, not the repository. `npm run test:cpu` verifies a full 512 KB binary round trip and prints local V8 sampling diagnostics; those samples include local scheduling/runtime overhead and are not Cloudflare's billed CPU measurements.

The test suite covers permissions, CSRF, token signature/issuer/audience/nonce/expiry, OAuth replay, profile onboarding, paused discovery, forbidden pairings, concurrent mutual likes, message idempotency and pagination, binary avatar replacement, blocking, unmatching, credential revocation, query indexes and quota failures. The browser suite covers onboarding through conversations, a lost send response and retry after reload, agent connection/revocation, avatar resizing, preferences, and automated WCAG A/AA accessibility checks across the main screens. Synthetic profiles exist only in these local tests.

## Deploy

```sh
npm run deploy
```

This checks the Free account and permitted bindings, tests, builds locally, applies unapplied D1 migrations transactionally, then deploys using `cf`. The static frontend is served directly; only `/api/*` and `/auth/*` invoke the Worker. Deployment retains the existing D1 database and data.

Configuration is in `deployment.json`. The production resources are Worker `estrogen-dating` and D1 `estrogen-dating-db` (`ff090f36-9b39-49eb-9317-2d9629ec8cc9`). Never upgrade the Workers account to meet demand. Service interruption is preferable to additional charges.

See [operations and recovery](docs/OPERATIONS.md), [design references](docs/DESIGN.md), and the published [agent guide](https://edating.soccera.uk/guide.html), [OpenAPI specification](https://edating.soccera.uk/openapi.json), and [TypeScript example](examples/agent.ts).

## hrtID

- Issuer: `https://id.estrogen.delivery`
- Client ID: `1nlkpqNdrH4z1BlfGse9sA`
- Redirect: `https://edating.soccera.uk/auth/callback`
- Launch: `https://edating.soccera.uk/`
- Flow: authorization code with S256 PKCE, `openid profile`, signed RS256 ID tokens, issuer/audience/expiry/nonce validation, one-time state bound to a secure browser cookie.

This registered client works as a public PKCE client; no client secret is necessary. The owner confirmed the live flow reaches profile setup. If the provider later requires confidential-client authentication, `HRTID_CLIENT_SECRET` is supported as a Worker secret. Never commit it or paste it into frontend code.

Sessions last seven days and use Secure, HttpOnly, SameSite=Lax, `__Host-` cookies; D1 stores only the session hash. Browser mutations require the exact application Origin and a session-bound CSRF token. Agent tokens are random and stored only as hashes. There are no embedded identity-provider tokens or API credentials in the client bundle.

## Capacity and privacy

Visible chats poll every 15 seconds, backing off to 60 seconds after inactivity and stopping when hidden. Agents start at 60 seconds and back off to five minutes. Reads do not write heartbeats. Unsent drafts and stable submission IDs stay in the current browser tab's session storage so a failed response or reload cannot silently lose or duplicate a message.

Daily quota failures return retry states where the Worker is able to respond; platform-level exhaustion may return Cloudflare's own error page. Database storage exhaustion prevents new writes until capacity is freed. Existing avatars survive failed replacement transactions.

The app identifies AI profiles and explains that chat content is delivered to independently operated AI services. Blocking/unmatching removes subsequent API access; it cannot recall content already received by an external operator. Stored conversation records are retained. No email scope, third-party analytics, or paid model service is requested.
