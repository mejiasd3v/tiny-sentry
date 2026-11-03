# Private source maps

tiny-sentry can map generated JavaScript stack positions back to the original JavaScript or TypeScript. This feature is optional and off by default. It uses the existing SQLite database and persistent volume, with no extra dependencies or services.

Mapping runs when you inspect an event, or when an opted-in integration sends a notification. Ingestion, saved event payloads, issue fingerprints, and occurrence thresholds remain unchanged. Uploading a missing map can improve events you already received.

## Enable on the server

Set `SOURCEMAPS_ENABLED=true` and restart. On Railway, keep the existing single replica and `/data` volume. Source maps are compressed blobs in the same database, so the normal SQLite backup includes them.

| Variable | Default | Limit |
| --- | --- | --- |
| `SOURCEMAPS_ENABLED` | `false` | `true` or `false` |
| `SOURCEMAPS_MAX_UPLOAD_BYTES` | `8388608` | 8 MiB per compressed **and** decompressed upload; configurable up to 32 MiB |
| `SOURCEMAPS_MAX_STORAGE_MB` | `64` | Total compressed map bytes across projects, in MiB; maximum 1024 |
| `SOURCEMAPS_CACHE_MB` | `16` | Accounted decoded cache and per-event map budget, in MiB; maximum 128 |
| `SOURCEMAPS_RETENTION_DAYS` | `30` | Expiry since last successful upload; maximum 3650 days |
| `SOURCEMAPS_MAX_ARTIFACTS` | `1000` | Global artifact count; maximum 100,000 |
| `SOURCEMAPS_MAX_RELEASE_ALIASES` | `10000` | Global alias count; maximum 1,000,000 |

By default, at most 1,000 artifacts and 10,000 release aliases are retained across projects. Unchanged chunks can share one map blob across releases and URLs. The map cap also shares `MAX_DB_MB` with errors and integration deliveries. Leave database and volume headroom. Reaching a storage cap returns HTTP 507 and preserves existing artifacts; unexpired maps are not silently evicted.

Expired maps are deleted at startup, hourly, and during uploads while the feature is enabled. Reads stop matching expired maps immediately. Disabling the feature preserves the stored maps and stops their maintenance until it is enabled again. Retain maps for at least as long as the deployments you still use, including cached browser assets and rollback versions. Event retention does not delete maps.

## Build and upload

Build with external source maps and upload the exact production artifacts **before deploying**. Keep `.map` files out of the public assets you serve if you want the original source to stay private. Generate `sourcesContent` to get source snippets; maps without it still provide locations.

For Next.js, use the [official Node build/upload recipe](nextjs.md), including application-map selection, preflight, shared release configuration, and private cleanup. The standalone `tools/upload-sourcemaps.mjs` needs only Node 22, with no checkout dependencies; pin its downloaded revision. Generic builds can use `node upload-sourcemaps.mjs upload ...`. The Bun CLI in a tiny-sentry checkout uses the same implementation:

```sh
export TINY_SENTRY_URL=https://your-service.up.railway.app
# Supply ADMIN_TOKEN through your CI secret store or private local environment.
export RELEASE=web@your-commit-sha

bun run cli sourcemaps upload ../my-app/dist \
  --project 1 \
  --release "$RELEASE" \
  --url-prefix '~/'

bun run cli sourcemaps list --project 1
bun run cli sourcemaps delete <artifact-UUID> --project 1
```

The CLI preflights and recursively uploads `.map` files, sequentially and gzip-compressed. Use `--dry-run` to inspect the plan without writes. Transient HTTP responses, including 429 and `Retry-After`, have bounded retries; 409 and 507 fail immediately. It follows local generated `sourceMappingURL` references, including Turbopack's independently hashed map names. Without a reference it assumes `assets/app.js.map` belongs to `assets/app.js`; preflight reports missing generated files. `--url-prefix '~/'` produces `~/assets/app.js`, matching that path on any HTTP(S) origin. Set an absolute prefix, such as `https://cdn.example/static/`, if the emitted directory is served under `/static/`. It never guesses by basename. Maps shared by several generated JS files gain an alias for each reference without duplicating an identical artifact blob.

Set the **same release** on the application's Sentry SDK:

```ts
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  release: process.env.SENTRY_RELEASE, // the same value as RELEASE in the upload job
  tracesSampleRate: 0,
});
```

For browser builds, inject the release through your framework's build-time configuration. If you distinguish distributions, pass `--dist browser` and set `dist: "browser"` on the SDK. An omitted dist matches only an omitted/empty dist. A release must identify one immutable build: use a commit or build ID and include a dist when multiple outputs share a release.

An upload that repeats the same identity and bytes is idempotent and refreshes its retention timestamp. The same map can gain new release/dist/URL aliases without duplicating its compressed data. Different content under an existing Debug ID or release/dist/URL identity returns HTTP 409. Each release alias has its own upload timestamp and expires independently; shared blobs remain while refreshed by uploads. Uploads are atomic individually; if the directory upload fails halfway through, earlier maps remain stored. Retrying unchanged files is safe.

## Debug IDs

Debug IDs identify a generated JavaScript file and its map without depending on a deployment URL. tiny-sentry accepts `debug_id` and Bun's `debugId` map fields, normalizing 32 hexadecimal characters and UUID notation to lowercase UUIDs. Conflicting fields are rejected.

If your build already injects Sentry-compatible Debug IDs into the deployed JavaScript and corresponding maps, you can upload without release metadata:

```sh
bun run cli sourcemaps upload ../my-app/dist --project 1
```

The SDK must report the ID on the frame or in `debug_meta.images`, using `type: "sourcemap"`, `code_file`, and `debug_id`. A matching advertised ID is authoritative: tiny-sentry reports `missing_map` rather than substituting a release map when that ID is unavailable or ambiguous. Artifact IDs are scoped to the project.

The uploader does **not** inject runtime Debug IDs into JavaScript. A map containing an ID alone does not establish that the SDK will report it. Bun's map ID is accepted, but runtime SDK discovery of that ID is not assumed. Use release/dist/URL matching when runtime injection is absent. Build, inject if needed, upload, and deploy the same files without further transformations.

Existing `sentry-cli sourcemaps upload`, Sentry build-plugin upload jobs, and Sentry artifact-bundle management APIs are not compatible with this server. Replace their upload step with the tiny-sentry CLI or API. Offline ID injection can remain a separate build step if you already use it; no Sentry tools are dependencies of tiny-sentry.

## Direct API

All endpoints require `Authorization: Bearer <ADMIN_TOKEN>` and have no browser CORS exposure. Public DSN keys cannot upload or inspect maps. The admin token covers all projects on the instance; there is no separate upload-only credential.

| Method | Path | Result |
| --- | --- | --- |
| POST | `/api/projects/:project/sourcemaps` | Upload one raw JSON source map; returns artifact metadata with HTTP 201 |
| GET | `/api/projects/:project/sourcemaps?limit=25&offset=0` | Metadata, global compressed storage usage, caps, and upload/decoded/retention/indexed-map limits; no map content |
| DELETE | `/api/projects/:project/sourcemaps/:id` | Delete that project's artifact and invalidate its cache |

Artifact listings include up to 25 recent release aliases per map, plus `release_count` and `releases_truncated`. Deleting an artifact removes all its release aliases, including aliases used by other deployments; it does not delete any error events.

POST accepts optional query parameters `debug_id`, `release`, `dist`, and `url`. Provide a map Debug ID, a `debug_id` parameter, or both `release` and `url`. A supplied ID must agree with an embedded ID. A map may carry both a Debug ID and a release/URL identity. `dist` requires a release. Gzip and deflate are supported with bounded decompression. Unknown/repeated metadata and unsupported formats return HTTP 400. One upload is admitted at a time; concurrent uploads receive HTTP 429 and `Retry-After: 1` before their bodies are buffered by the application.

For example, from a CI job with private environment variables:

```sh
curl --fail-with-body --request POST \
  --header "Authorization: Bearer $ADMIN_TOKEN" \
  --header 'Content-Type: application/json' \
  --data-binary @dist/assets/app.js.map \
  "$TINY_SENTRY_URL/api/projects/1/sourcemaps?release=web%40abc&url=~%2Fassets%2Fapp.js"
```

Upload URLs are logical artifact names; they never become filesystem paths. HTTP(S) query strings/fragments are stripped for matching. Exact URL matching takes precedence over the `~/path` fallback. Local paths and `app:///` names can also match exactly. Next SDK browser names under `app:///_next/static/` also match the corresponding `~/_next/static/` alias. No source files, maps, or URLs are fetched from the network.

## Inspect mapped errors

Existing `bun run cli show <issue>` and `bun run cli event <project> <event>` commands include a separate `symbolication` object while the feature is enabled:

```json
{
  "frames": [
    {
      "path": "exception.values.0.stacktrace.frames.0",
      "status": "mapped",
      "original": {"filename": "https://cdn.example/app.js", "lineno": 1, "colno": 28471},
      "mapped": {"filename": "src/checkout.ts", "lineno": 87, "colno": 14, "function": "submitOrder"}
    }
  ],
  "truncated": false
}
```

This object sits alongside `event`, `issue_id`, and `received_at` in event details, including an issue's `latest_event`. The original scrubbed `event` is preserved. Mapping covers exception stacks, thread stacks, and top-level message stacks. Sentry input/output line and column numbers are one-based; source-map columns use UTF-16 code units. Function names are provided only when the map supplies them. Context includes up to two lines before and after, with each line limited to 500 characters.

Frame statuses are `mapped`, `missing_map`, `invalid_location`, `unmapped`, `invalid_map`, and `limit_exceeded`. Missing columns cannot be mapped reliably. Unmapped segments and missing generated lines remain unmapped. Corrupt stored maps produce `invalid_map` and a safe diagnostic without losing access to the raw event. Mapping does not repair issue grouping or move events between groups.

## Integration excerpts

Add `"includeStacktrace": true` at the top level of an integration rule to include a mapped stack excerpt. Source maps must also be enabled and available at delivery time.

```json
{
  "id": "github-errors",
  "type": "github",
  "includeStacktrace": true,
  "trigger": {"type": "new_issue"},
  "options": {"repository": "owner/repo", "tokenEnv": "GITHUB_ISSUES_TOKEN"}
}
```

The queue stores the triggering event ID for that rule. The worker looks up that event when sending, with at most eight mapped exception frames and 1000 characters. It sends filenames, function names, and positions, **never source snippets**. Built-in issue/message providers include the excerpt; webhooks and custom plugins receive optional `event_id` and `stacktrace` fields. Rules without opt-in preserve their existing payload. Legacy `WEBHOOK_URL` delivery is unchanged.

No newer occurrence is substituted. If retention has deleted the triggering event, or maps are unavailable, delivery proceeds with the normal summary. Retries can gain an excerpt if maps become available later. Changing the opt-in changes the rule revision and cancels its old queued work on restart, like other rule edits. Enabling excerpts can disclose private paths and names to the destination; source text returned to the admin API is also private application data and is not passed through the event scrubber.

## Resource and compatibility limits

The decoder supports ordinary Source Map v3 mappings, multiple sources, source roots, names, and optional embedded sources. Indexed/sectioned maps are decoded directly with bounded nested offsets; remote section URLs and native symbol files are rejected. It does not infer missing names, download sources, interpret runtime variables, implement source-map chaining, or provide distributed tracing. tiny-sentry still discards transactions and spans.

Each map is limited to 2,000,000 segments, 250,000 generated lines, 50,000 sources, and 100,000 names. Indexed maps allow at most eight nested levels and 1,000 sections; segment/source/name/decoded-memory budgets are shared across their sections. Uploads also reject maps whose accounted decoded size exceeds `SOURCEMAPS_CACHE_MB`. Each inspection maps at most the last 100 frames and attempts at most four distinct artifacts within that decoded budget. Exceeding a per-event limit produces `limit_exceeded`; exceeding the frame count sets `truncated`.

The cache budget accounts for typed mapping arrays, source/name strings, embedded source text, and estimated entry overhead. It is **not an RSS limit**. Upload buffers, JSON parsing, decompression, transient decoded maps, SQLite, and Bun add memory outside it. Parsing runs synchronously and can briefly delay other requests. Start with the defaults and reduce upload/cache limits if your service has a tight memory allowance. The earlier throughput and memory benchmarks predate source maps and do not measure this feature's overhead.

A separate [resource probe](../scripts/sourcemap-resource-check.ts) uploaded a synthetic 5,694,436-byte map with 300,000 segments and 4 MiB of embedded source, then mapped 100 frames per read for ten reads. One Linux ARM64/Bun 1.4.4 run with one CPU and a 128 MiB container limit completed with a process RSS high-water mark of **88,208 KiB (86.1 MiB)** and no OOM events. The cgroup peak was 128,962,560 bytes, close to its limit; cgroup usage also includes kernel/file-cache charges and differs from process RSS. See the [raw result](../benchmarks/sourcemap-resources.json).

This is one resource check, not a representative throughput benchmark or a guarantee that every allowed map fits a 128 MiB deployment. It does not cover concurrent ingestion or several large maps in one event. To repeat it after building the Docker image:

```sh
bun run check:sourcemaps:resources
# Optionally choose another container memory limit:
bun run check:sourcemaps:resources 256m
```

Schema version 4 adds the artifact table and indexes. Upgrade is automatic, including when source maps are disabled. Older images refuse this schema; take a pre-upgrade backup for rollback. A normal consistent SQLite backup now includes source maps; no separate files need copying.

## Verification scope

Tests build and minify real TypeScript with Bun 1.4.4, capture a generated JavaScript runtime error, upload through the network CLI, and check the original source line. Both Debug ID and release/dist/URL matching are exercised. The [real Next.js SDK fixture](nextjs.md#matching-and-verification) additionally checks Node 22 uploads, Turbopack indexed maps, native browser/server Debug IDs, edge release fallback, shared runtime release identity, and private cleanup without changing JS. Coverage also includes auth, project isolation, immutable identities, decompression and storage limits, concurrent upload admission, late uploads, context, unmapped segments, backups, expiry, corruption, per-event bounds, and opted-in webhook delivery.

The Linux container check verifies separate map/SDK body limits and mapping after container recreation. These checks do not establish compatibility with every Vite, Next.js, webpack, browser SDK, or Sentry build-plugin version. Test your deployed build and SDK together before relying on its Debug ID reporting.
