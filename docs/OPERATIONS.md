# Operations and recovery

## Cost boundary

Keep the Cloudflare account on Workers Free. The deployment guard checks account subscriptions, verifies the selected account, allows one D1 binding plus static assets/configuration/secrets, and refuses additional resources or unreviewed Worker options. Observability storage, Logpush, preview URLs and workers.dev are disabled. Normal deployments never create a subscription or raise a quota.

Cloudflare's current Free limits are 100,000 Worker requests/day and 10 ms CPU/request, D1 5 million rows read/day, 100,000 rows written/day, and 500 MB for this database. Static-asset requests do not invoke application code. Avatars, messages, indexes and all other D1 tables share the database limit. Limits apply across other usage in the same account where Cloudflare specifies account quotas.

Sources: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

The upload API has bounded byte reads and header parsing, and performs no decompression/resizing on the Worker. Native V8 hex codecs and SQLite `unhex()` avoid expensive JSON arrays of hundreds of thousands of numbers. The stored data remains binary BLOB data; the hex representation exists only during D1 transport.

On 2026-09-27, Cloudflare live traces for a 512 KB transport benchmark measured upload processing at **8, 6, 6, 5, 5 ms** and download processing at **4, 3, 3, 3, 3 ms**, with all responses successful. This exercised the deployed codecs, bounded image validation, hashing, three small D1 reads and full-size D1 parameters/results. It used synthetic SQL results instead of altering anyone's profile. Separate local integration tests verify actual BLOB storage/replacement and binary equality. Startup was 2 ms. Local inspector samples were higher because they include local runtime and scheduling overhead; do not interpret them as Cloudflare's per-request CPU meter. These measurements cover the tested workload, not every future platform/runtime version.

The temporary diagnostic route, live trace, and diagnostic Worker versions were removed after measurement; no benchmark profiles or images were inserted into production.

## Check service and storage

```sh
npm run check:free
curl --fail https://edating.soccera.uk/api/v1/status
cf workers get estrogen-dating
cf d1 get c947cb5b-b867-4d61-a8ee-37b8283ee37d
```

`cf` must be on PATH for commands shown directly; this machine's installation is `/home/lily/.npm-global/bin/cf`. Use the D1 dashboard for row usage and database size. Do not enable paid analytics to monitor this app.

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

On 2026-09-27 the database was deliberately replaced instead of migrated: the previous `ff090f36-9b39-49eb-9317-2d9629ec8cc9` held one testing account and was dropped, `c947cb5b-b867-4d61-a8ee-37b8283ee37d` was created with the same name, and `0001_initial.sql` was applied to it. `deployment.json` carries the new ID. A pre-replacement SQL export is at `/tmp/.private/lily/opencode/prod-backup-pre-18-removal.sql` if that account is ever needed.

## Code rollback

Read available versions:

```sh
cf workers versions list --worker-id estrogen-dating
```

Create a JSON file containing the known-good version, for example:

```json
[{"version_id":"KNOWN_GOOD_VERSION_UUID","percentage":100}]
```

Then switch traffic:

```sh
cf workers deployments create --worker estrogen-dating --strategy percentage --versions @/tmp/edating-rollback.json
```

Rollback changes code and static assets, not D1 records. Avoid `--force`, especially when secret bindings changed. Recheck `/api/v1/status`, authentication, active conversations and the database ID after a rollback. The current production version is `7156fbd2-2a9d-449f-bd9b-68862d7d3c98`; `800d215e-30ae-4358-8486-339b839e4566` is the earliest version that matches the present schema. Anything older, including the original `cb9c61a0-f58f-4611-bc7b-bda01fb29e61`, expects the replaced schema and must not be rolled back to.

## Database recovery

D1 Free includes seven days of Time Travel. Capture a bookmark before a migration or other substantial data change:

```sh
cf d1 time-travel get-bookmark c947cb5b-b867-4d61-a8ee-37b8283ee37d
```

To recover, first decide which newer writes may be lost and stop accepting new writes during the recovery window. Restore to the chosen bookmark with the confirmation prompt intact:

```sh
cf d1 time-travel restore c947cb5b-b867-4d61-a8ee-37b8283ee37d --bookmark SAVED_BOOKMARK
```

A database restore can bring back previously revoked credentials and closed matches. Review and reapply revocations/blocks made after the recovery point before reopening access. Check `d1_migrations`, align the deployed code with the restored schema, verify profile/avatar/message access, and then resume traffic. A code-only rollback is preferable when the data itself is sound.

## Secrets and hrtID configuration

The current public PKCE client needs no client secret. If hrtID changes the client type, use a local file outside the repository with restrictive permissions containing `HRTID_CLIENT_SECRET`, then deploy with `cf deploy --prebuilt --secrets-file /path/to/private-secrets.json`. Remove the local file after configuration. Never add secrets to `deployment.json`, Vite environment variables, or agent examples. Re-run Free checks before deployment, and keep the production callback unchanged unless hrtID registration changes too.
