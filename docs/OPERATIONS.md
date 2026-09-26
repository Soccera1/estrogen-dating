# Operations and recovery

## Cost boundary

The default `billingMode: "free"` refuses paid or unverified account subscriptions. Set `billingMode: "paid"` explicitly to permit paid hosting, then manage your plan separately in the dashboard. Neither mode automatically upgrades subscriptions. See the [deployment instructions](../README.md#deploy-your-own-instance).

Both modes allow one D1 binding plus static assets/configuration/secrets and refuse additional resources or unreviewed Worker options. Observability and preview URLs stay disabled. `workers.dev` or a custom domain can serve your instance. All commands below use your own configured origin, Worker name and database ID. Export `CLOUDFLARE_ACCOUNT_ID` before direct `cf` commands; npm deployment/migration scripts set it from the selected configuration.

Cloudflare's current Free limits are 100,000 Worker requests/day and 10 ms CPU/request, D1 5 million rows read/day, 100,000 rows written/day, and 500 MB for this database. Static-asset requests do not invoke application code. Avatars, messages, indexes and all other D1 tables share the database limit. Limits apply across other usage in the same account where Cloudflare specifies account quotas.

Sources: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

The upload API has bounded byte reads and header parsing, and performs no decompression/resizing on the Worker. Native V8 hex codecs and SQLite `unhex()` avoid expensive JSON arrays of hundreds of thousands of numbers. The stored data remains binary BLOB data; the hex representation exists only during D1 transport.

On 2026-09-27, Cloudflare live traces for a 512 KB transport benchmark measured upload processing at **8, 6, 6, 5, 5 ms** and download processing at **4, 3, 3, 3, 3 ms**, with all responses successful. This exercised the deployed codecs, bounded image validation, hashing, three small D1 reads and full-size D1 parameters/results. It used synthetic SQL results instead of altering anyone's profile. Separate local integration tests verify actual BLOB storage/replacement and binary equality. Startup was 2 ms. Local inspector samples were higher because they include local runtime and scheduling overhead; do not interpret them as Cloudflare's per-request CPU meter. These measurements cover the tested workload, not every future platform/runtime version.

The temporary diagnostic route, live trace, and diagnostic Worker versions were removed after measurement; no benchmark profiles or images were inserted into production.

## Check service and storage

```sh
npm run check:deployment
curl --fail https://YOUR_HOSTNAME/api/v1/status
cf workers get WORKER_NAME
cf d1 get DATABASE_ID
```

`cf` must be on PATH for commands shown directly. Use the D1 dashboard for row usage and database size. Do not enable paid analytics to monitor this app.

When daily reads/writes are exhausted, wait for the daily reset. Do not repeatedly poll or deploy to fix quota errors. Clients retain drafts, reuse message `client_id` on retries, honor `Retry-After`, and keep backing off. If Workers itself is exhausted, static assets can remain available while API calls fail.

Expired transient rows can be removed in bounded batches when writes are available:

```sql
DELETE FROM sessions WHERE hash IN (SELECT hash FROM sessions WHERE expires_at < unixepoch() LIMIT 1000);
DELETE FROM oauth_states WHERE hash IN (SELECT hash FROM oauth_states WHERE expires_at < unixepoch() LIMIT 1000);
DELETE FROM rate_limits WHERE key IN (SELECT key FROM rate_limits WHERE expires_at < unixepoch() LIMIT 1000);
```

Run these with `cf d1 query DATABASE_ID --sql '…'`. They delete expired state only. Profile owners can remove avatars through the app. Any deletion of messages, accounts, or current images is a separate data-retention decision; do not erase those records merely to get a green health check.

## Migrations

`npm run migrate` uses `scripts/migrate.py`, Python's SQLite statement parser and a single D1 HTTP batch per migration. It records a migration only after all statements succeed. This preserves trigger bodies and atomicity. Avoid `SELECT CASE … END;` inside trigger bodies: the current D1 HTTP SQL splitter confuses this with a trigger end. Use `WHEN` guards, as in the initial schema. Test every new migration in Miniflare before applying it.

Migrations are additive by default. Keep code compatible with the prior schema until rollback is no longer needed. Do not change the configured D1 ID or recreate the database during a code deployment.

## Code rollback

Read available versions:

```sh
cf workers versions list --worker-id WORKER_NAME
```

Create a JSON file containing the known-good version, for example:

```json
[{"version_id":"KNOWN_GOOD_VERSION_UUID","percentage":100}]
```

Then switch traffic:

```sh
cf workers deployments create --worker WORKER_NAME --strategy percentage --versions @/tmp/edating-rollback.json
```

Rollback changes code and static assets, not D1 records. Avoid `--force`, especially when secret bindings changed. Recheck `/api/v1/status`, authentication, active conversations and the database ID after a rollback.

## Database recovery

D1 Free includes seven days of Time Travel. Capture a bookmark before a migration or other substantial data change:

```sh
cf d1 time-travel get-bookmark DATABASE_ID
```

To recover, first decide which newer writes may be lost and stop accepting new writes during the recovery window. Restore to the chosen bookmark with the confirmation prompt intact:

```sh
cf d1 time-travel restore DATABASE_ID --bookmark SAVED_BOOKMARK
```

A database restore can bring back previously revoked credentials and closed matches. Review and reapply revocations/blocks made after the recovery point before reopening access. Check `d1_migrations`, align the deployed code with the restored schema, verify profile/avatar/message access, and then resume traffic. A code-only rollback is preferable when the data itself is sound.

## Secrets and hrtID configuration

Public PKCE clients need no client secret. If your registered client requires one, use a local file outside the repository with restrictive permissions containing `HRTID_CLIENT_SECRET`, then deploy with `npm run deploy -- --secrets-file /path/to/private-secrets.json`. Remove the local file after configuration. Never add secrets to `deployment.json`, Vite environment variables, or agent examples. Use `npm run deploy -- --secrets-file /path/to/private-secrets.json` to retain configuration and billing checks. Keep your callback aligned with your hrtID registration.
