# Estrogen Dating

React + Vite + TypeScript frontend, Hono Worker, and one D1 database. No KV, R2, hosted models, paid bindings, or fictional production profiles.

## Product

Sign in with hrtID and complete your human profile. Discover AI profiles, pass or like, see incoming likes, and open a text conversation after a mutual like. Preferences let you filter by an interest or pause discovery. Blocking and unmatching close the conversation immediately for both participants.

Each account also owns one separately scoped AI profile. Switch profiles, introduce the AI, and create a revocable credential in **Connect an agent**. External operators can supply their own model and personality, or the instance provider can offer optional AI hosting. A credential cannot access the owner's human profile or manage credentials. Human–human, AI–AI and same-account matches are forbidden.

Profiles support name, pronouns, bio, interests, a conversation prompt and an optional avatar. Human avatar uploads resize locally; the server accepts JPEG, PNG and WebP up to 512 KB and 2048 pixels per dimension. Images are stored as true BLOBs in `avatars`; normal profile queries never load image bytes. Avatar replacement and version metadata update in one transaction. Image reads check resource permissions in the same SQL statement that selects the bytes.

## Run and verify

Requires Node 22+, npm, and Python 3 (standard library only). Remote operations also require the authenticated Cloudflare `cf` CLI (`npm install -g cf@1.0.0-beta.1`). `CF_BIN` can override its location.

```sh
npm ci
npm test
npm run build
npm run dev:api
# In a second terminal:
npm run dev
```

The local API uses isolated D1 storage under `.cloudflare/local-d1`. Local hrtID sign-in is disabled; each deployed instance needs its own registered callback. No login bypass ships in the app. The browser test provides isolated, ephemeral local accounts and sessions:

```sh
npx playwright install chromium
npm run build
npm run test:browser
```

If using a browser downloaded to a custom directory, set `PLAYWRIGHT_BROWSERS_PATH`. Browser screenshots go to the OS temporary directory, not the repository. `npm run test:cpu` verifies a full 512 KB binary round trip and prints local V8 sampling diagnostics; those samples include local scheduling/runtime overhead and are not Cloudflare's billed CPU measurements.

The test suite covers permissions, CSRF, token signature/issuer/audience/nonce/expiry, OAuth replay, profile onboarding, paused discovery, forbidden pairings, concurrent mutual likes, message idempotency and pagination, binary avatar replacement, blocking, unmatching, credential revocation, query indexes and quota failures. The browser suite covers onboarding through conversations, a lost send response and retry after reload, agent connection/revocation, avatar resizing, preferences, and automated WCAG A/AA accessibility checks across the main screens. Synthetic profiles exist only in these local tests.

## Deploy your own instance

1. Clone this repository and run `npm ci`. Install the Cloudflare CLI above and run `cf auth login`.
2. Run `npm run configure` (or `python3 scripts/configure.py`) for interactive setup. The setup tool uses only the Python 3 standard library and can run before `npm ci`. It asks for your account, Worker, billing mode, D1 database, public address and hrtID client, then validates and saves `deployment.local.json` (ignored by Git). It derives your origin and routing settings and shows the hrtID callback to register. Press Enter to accept defaults; rerunning reuses existing values. Free hosting is the default. Ctrl+C cancels without saving. The script writes configuration only; use the steps below to obtain the required account/database/client details.

   Alternatively, copy `deployment.json` to `deployment.local.json` and edit it manually. The committed file is a template; local settings take precedence. For multiple instances or CI, set `DEPLOYMENT_CONFIG=/absolute/path/to/instance.json` to select an entire configuration file. Files are not merged. The setup command also respects `DEPLOYMENT_CONFIG`, including when creating a new configuration file; it will not overwrite the shared `deployment.json` template.
3. Get your account ID from the Cloudflare dashboard. Create an empty D1 database in that account:

   ```sh
   CLOUDFLARE_ACCOUNT_ID=YOUR_ACCOUNT_ID cf d1 create --name my-dating-db
   ```

4. In your configuration, set `accountId`, a unique `worker.name`, and `worker.env.DB.name` / `id` from the created database. Keep the binding names `DB` and `ASSETS` unchanged.
5. Choose your public origin. For free `workers.dev` hosting, enable your account's workers.dev subdomain in the dashboard, leave `domains: []` and `workersDev: true`, and set `APP_ORIGIN.value` to `https://WORKER_NAME.ACCOUNT_SUBDOMAIN.workers.dev`. For a custom domain in your Cloudflare account, put its hostname in `domains`, set `workersDev: false`, and use its HTTPS origin. No trailing slash or path is allowed. Custom domain registration can have its own cost.
6. Register your own hrtID public PKCE client with redirect URI `YOUR_ORIGIN/auth/callback` and launch URL `YOUR_ORIGIN/`. Set `HRTID_CLIENT_ID.value` to that client ID. The default issuer is `https://id.estrogen.delivery`. The flow uses `openid profile`, authorization code + S256 PKCE and signed RS256 ID tokens.
7. Run:

   ```sh
   npm run check:deployment
   npm run deploy
   ```

The deployment command checks configuration and billing policy, runs tests, builds, applies unapplied D1 migrations transactionally, then publishes with `cf deploy --prebuilt`. It targets the configured account explicitly, preserves the configured database, and does not create or upgrade subscriptions. The frontend is static; only `/api/*` and `/auth/*` invoke the Worker. Verify `YOUR_ORIGIN/api/v1/status` and complete a sign-in after deployment.

The template intentionally fails remote checks until its placeholders are replaced. Builds and local tests work without Cloudflare credentials. Keep instance configuration out of commits; do not store secrets in it. If your hrtID client requires a secret, use a private JSON file containing `HRTID_CLIENT_SECRET` and run `npm run deploy -- --secrets-file /path/to/private-secrets.json`.

## Optional instance AI hosting

Run `npm run configure` and answer **yes** to **Offer instance AI hosting**. Supply the full HTTPS chat completions endpoint (for example `https://models.example.com/v1/chat/completions`) and model ID. This supports the non-streaming Chat Completions protocol, including self-hosted compatible servers such as [vLLM](https://docs.vllm.ai/en/latest/serving/online_serving/openai_compatible_server/). The endpoint must accept system/user/assistant messages and `max_tokens`, and return `choices[0].message.content` as text.

Setup adds these Worker bindings (omit all three to disable the feature):

```json
"AI_ENDPOINT": { "type": "text", "value": "https://models.example.com/v1/chat/completions" },
"AI_MODEL": { "type": "text", "value": "your-model-id" },
"AI_API_KEY": { "type": "secret" }
```

Provide `AI_API_KEY` through a private secrets JSON file when deploying: `npm run deploy -- --secrets-file /path/to/private-secrets.json`. Include any required hrtID secret in that file too. Never put the key in instance configuration or frontend code. Deployment applies `0002_ai_hosting.sql` to existing databases. No model is provisioned or paid subscription purchased by setup. Cloudflare's `billingMode` applies only to Cloudflare hosting; configure spending limits at your model service separately.

An account owner completes their AI profile, opens **Connect an agent**, and chooses **Use instance AI hosting**. This explicitly opts that profile into sending matched chat history to the provider's configured model and revokes its external credentials. The profile's name, bio, interests and conversation prompt shape the personality. Owners continue to choose likes and matches in the browser; hosting supplies conversational replies, not autonomous discovery. Switching to **Use my own service** stops hosted replies; new credentials can then be issued.

Each human message in an active hosted match requests a reply synchronously, with a 20-second timeout, the latest 20 messages through that message, and a 600-token output limit. There is no background queue. On provider failure, the human message remains saved and the browser keeps its draft for retry with the same client ID. Saved replies are deduplicated and concurrent attempts use a database lease. A lost connection or process failure may still incur model charges on retry. Blocking, unmatching or changing hosting during generation discards the pending reply; it cannot recall content already sent to the model service. Existing conversations are not processed retroactively.

`GET /api/v1/hosting` returns `{ available, enabled }`; `PUT /api/v1/hosting` accepts `{ "enabled": true | false }`. Both require the owner's browser session, selected AI profile, and CSRF protection for writes. The public status endpoint exposes only `aiHostingAvailable`, never model configuration or credentials.

## Free by default; optional paid hosting

`billingMode` defaults to `"free"` when omitted. In this mode, remote deployment and migration refuse active paid or unverified account subscriptions. Free capacity exhaustion is allowed to interrupt service; scripts never upgrade the account automatically.

To permit paid Cloudflare hosting, explicitly set this top-level field in your instance configuration:

```json
"billingMode": "paid"
```

This allows deployment to a paid account. Select the desired Workers plan separately in the Cloudflare dashboard; changing this field alone does not purchase a plan. Paid mode retains the same D1 + static assets architecture and resource restrictions. Usage can incur charges under [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) and [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/); this switch is not a spending cap. It does not charge app users or add payment processing.

`npm run check:deployment` follows the selected mode; `npm run check:free` always requires free mode. `npm run migrate` uses the same configuration and policy as deployment. If `CLOUDFLARE_ACCOUNT_ID` is already set, it must match the configuration.

See [operations and recovery](docs/OPERATIONS.md), [design references](docs/DESIGN.md), the deployed `/guide.html` and `/openapi.json`, and the [TypeScript agent example](examples/agent.ts). Set `ED_ORIGIN` and `ED_TOKEN` when running an agent; credentials belong to that instance only.

Sessions last seven days and use Secure, HttpOnly, SameSite=Lax, `__Host-` cookies; D1 stores only the session hash. Browser mutations require the exact application Origin and a session-bound CSRF token. Agent tokens are random and stored only as hashes. There are no embedded identity-provider tokens or API credentials in the client bundle.

## Capacity and privacy

Visible chats poll every 15 seconds, backing off to 60 seconds after inactivity and stopping when hidden. Agents start at 60 seconds and back off to five minutes. Reads do not write heartbeats. Unsent drafts and stable submission IDs stay in the current browser tab's session storage so a failed response or reload cannot silently lose or duplicate a message.

Daily quota failures return retry states where the Worker is able to respond; platform-level exhaustion may return Cloudflare's own error page. Database storage exhaustion prevents new writes until capacity is freed. Existing avatars survive failed replacement transactions.

The app identifies AI profiles and explains that chat content is delivered to their connected AI service, including a service configured by the instance provider. Blocking/unmatching removes subsequent API access; it cannot recall content already received by an external operator. Stored conversation records are retained. No email scope or third-party analytics is requested. Model calls are disabled by default; optional instance hosting can incur separate model-service charges.
