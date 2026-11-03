# tiny-sentry

Headless error tracking for personal projects. Keep your Sentry SDK, change its DSN, and send errors to one small service.

**Bun + TypeScript + Hono + SQLite.** Hono is the only runtime dependency. No dashboard, Postgres, Redis, queue, or separate worker. Inspect errors with the CLI or JSON API.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/github)

The button opens Railway's GitHub deploy flow. Select `mejiasd3v/tiny-sentry`, then [add credentials and a persistent volume](#deploy-on-railway). It does not provision a preconfigured template.

## Start locally

Requires [Bun](https://bun.sh) 1.4.2 or newer.

```sh
git clone https://github.com/mejiasd3v/tiny-sentry.git
cd tiny-sentry
bun install --frozen-lockfile
bun run setup
bun start
```

Setup creates a gitignored `.env` with random credentials and prints your local DSN. It never overwrites an existing file. Bun loads `.env` automatically.

In another terminal:

```sh
bun run cli projects
bun run cli issues
bun run cli show 1
bun run cli resolve 1
```

## Deploy on Railway

Run one replica with one persistent volume. You do not need a database service.

1. Run the local setup above to generate credentials. On Railway, create a project from the `mejiasd3v/tiny-sentry` GitHub repository. Railway detects the Dockerfile.
2. Add a volume to that service mounted at **`/data`**. The Docker image defaults to `DB_PATH=/data/tiny-sentry.sqlite`. Without this volume, a redeploy loses your data.
3. Copy **`ADMIN_TOKEN`** and **`SENTRY_PROJECTS`** from your local `.env` into the service variables. Keep the admin token private. The initial deployment may fail until these variables are set; it refuses to start without credentials.
4. Set the service healthcheck path to **`/health`**, keep **one replica**, and generate a public domain targeting port **3000**. Redeploy with the volume and variables attached.
5. Use `https://<project-public-key>@<your-railway-domain>/1` as your Sentry DSN.

The Dockerfile supplies the start command and Railway's `PORT` is respected. There is no build step for the application. The final image contains Bun, Hono, and the TypeScript sources; development tools stay out of it. Railway's older `railway.json` configuration is deprecated, so setup uses the current service settings directly.

### Keep costs down

Start with the defaults: 14-day retention, 10,000 events across all projects, a 256 MiB SQLite page limit, and 120 ingestion requests per project per minute. One envelope can contain up to 100 items. Disable tracing, replay, profiling, and SDK log collection in clients, so they do not send data you will discard.

Railway's **Serverless** setting can let an idle service sleep. This service has no periodic outbound polling. Waking adds latency and can exceed a short SDK flush deadline, especially when reporting from a short-lived process. Keep it always on if delivery matters more than the idle savings. Persistent data stays on the volume through sleep.

Local Linux ARM64 runs measured about **43 MiB of process RSS at idle** and a **75 MiB high-water mark under load**, inside a 128 MiB container limit. See the [memory analysis and scoped Sentry benchmark](benchmarks/README.md) for workloads, raw results, cost interpretation, and limitations.

Railway bills actual resources and volume usage, subject to your plan and included credits. See [current Railway pricing](https://docs.railway.com/pricing/plans); a small service does not guarantee a free account or a fixed monthly bill. Set a Railway usage limit. Check the service's measured memory and CPU before changing limits.

## Switch an existing project

Use the same public key you configured for the project ID in `SENTRY_PROJECTS`. Every SDK that uses Sentry's envelope or JSON store protocol should be able to send **error events**. Node and browser SDK `11.10.0` and Python SDK `2.73.0` were smoke-tested against a real local HTTP listener.

### JavaScript / TypeScript

Keep your existing Sentry package (`@sentry/node`, `@sentry/browser`, `@sentry/nextjs`, etc.) and initialization. Replace its DSN and disable integrations for unsupported data:

```ts
import * as Sentry from "@sentry/node"; // or your existing Sentry SDK

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  tracesSampleRate: 0,
  sendDefaultPii: false,
  // Remove replay/profiling/logging integrations from your existing config.
});

Sentry.captureException(new Error("Something broke"));

// Before a short-lived script or serverless invocation exits:
await Sentry.flush(5000);
```

Browser DSNs are public. Use your framework's public environment variable for the DSN; **never expose `ADMIN_TOKEN` to a browser**. With Next.js, keep the normal Sentry client/server setup and replace the DSNs in both. Release/source-map upload jobs still target Sentry's separate management APIs; disable those uploads for this service.

### Python

```python
import os
import sentry_sdk

sentry_sdk.init(
    dsn=os.environ["SENTRY_DSN"],
    traces_sample_rate=0,
    send_default_pii=False,
)

try:
    raise ValueError("Something broke")
except ValueError:
    sentry_sdk.capture_exception()

sentry_sdk.flush(timeout=5)
```

### Multiple personal projects

Set one entry per project in the service's `SENTRY_PROJECTS` JSON object:

```json
{"1":"random-public-key-for-your-web-app","2":"another-random-key-for-your-api"}
```

IDs must be positive numeric strings; keys must be 16-128 URL-safe characters. Generate a key with `openssl rand -hex 16`. Each project gets its own DSN (`.../1`, `.../2`) and rate limit. Restart/redeploy after changing configuration. Removing or rotating a key stops ingestion with that key; existing records remain visible to the admin API until retention removes them.

## What is compatible

- `POST /api/:project/envelope/` and `POST /api/:project/store/`, with or without the trailing slash.
- Public-key authentication through `sentry_key`, `X-Sentry-Auth`, or the envelope DSN. Browser CORS and preflight requests.
- JSON error/message events, UTF-8 envelope item byte lengths, gzip and zlib-wrapped deflate requests.
- Exceptions, stack traces, breadcrumbs, tags, contexts, environment, release, and other JSON event fields are retained after scrubbing.
- Repeated event IDs are idempotent within a project while the event is retained. New IDs increment the group's lifetime count. A new event in a resolved group reopens it.
- Simple grouping by exception type and application stack filename/function, falling back to the log message template or event title. Custom `fingerprint` arrays and `{{ default }}` are supported. Grouping is project-scoped and spans environments.

This replaces **Sentry error ingestion**, not all of Sentry. Transactions, spans, replay, sessions, attachments, profiles, metrics, check-ins, feedback, and SDK logs are consumed and discarded with a successful response. Native crash reports/minidumps, source-map uploads, symbolication, Sentry's issue-management API, organizations, and Sentry CLI release commands are not implemented. Minified JavaScript stacks stay minified; native SDKs that report crashes through other endpoints are not supported. Existing events in your Sentry account are not imported.

## CLI and JSON API

For a deployed service, set `TINY_SENTRY_URL=https://your-service.up.railway.app` in your local `.env`. Its `ADMIN_TOKEN` must match the server's. Output is JSON, suitable for `jq` and scripts.

```sh
bun run cli issues --project 1 --status unresolved --limit 20 --offset 0
bun run cli show 42
bun run cli events 42
bun run cli event 1 0123456789abcdef0123456789abcdef
bun run cli resolve 42
bun run cli reopen 42
bun run cli stats
```

The API uses `Authorization: Bearer <ADMIN_TOKEN>`:

| Method | Path | Result |
| --- | --- | --- |
| GET | `/health` | Public database availability check |
| GET | `/api/projects` | Configured project IDs, without their public keys |
| GET | `/api/stats` | Retained issue and event counts |
| GET | `/api/issues?project=1&status=unresolved&limit=25&offset=0` | Issues, newest first; filters optional |
| GET | `/api/issues/:id` | Issue and latest retained event |
| GET | `/api/issues/:id/events?limit=25&offset=0` | Retained event metadata |
| PATCH | `/api/issues/:id` | Set `{"status":"resolved"}` or `{"status":"unresolved"}` |
| GET | `/api/projects/:project/events/:event_id` | Full scrubbed event |

Page size is 1-100. `first_seen`, `last_seen`, and `received_at` are Unix milliseconds recorded by the server. The SDK's original timestamp remains in the event JSON.

## Notifications

New issues and regressions produce structured JSON lines in Railway logs. Repeated occurrences of an unresolved issue do not produce another notice. Event payloads, keys, and admin tokens are not logged.

Optionally set `WEBHOOK_URL` to receive a JSON POST:

```json
{"kind":"new_issue","issue":{"id":42,"project_id":"1","title":"TypeError: Something broke","status":"unresolved","event_count":1}}
```

The issue also includes fingerprint, level, and timestamps. Set `WEBHOOK_TOKEN` to attach an `Authorization: Bearer ...` header. Use a receiver that accepts this JSON format; Slack and Discord expect their own payload formats. Delivery is **best effort**, with a five-second timeout, at most four requests in flight, no retries, and no durable queue. Failures appear in logs and never undo an accepted event. Do not rely on it for guaranteed paging.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `ADMIN_TOKEN` | Required | Private management token, at least 32 characters |
| `SENTRY_PROJECTS` | Required | JSON map of project ID to public ingestion key |
| `DB_PATH` | `./data/tiny-sentry.sqlite` | SQLite path; Docker uses `/data/tiny-sentry.sqlite` |
| `PORT` | `3000` | HTTP port, bound to `0.0.0.0` |
| `RETENTION_DAYS` | `14` | Expire events by server receive time |
| `MAX_EVENTS` | `10000` | Retained event cap across all projects |
| `MAX_DB_MB` | `256` | Main SQLite database page cap in MiB |
| `MAX_REQUEST_BYTES` | `1048576` | Compressed and decompressed request limits |
| `MAX_EVENT_BYTES` | `131072` | Individual JSON event limit |
| `RATE_LIMIT_PER_MINUTE` | `120` | Ingestion requests per project per fixed minute |
| `WEBHOOK_URL` | Unset | Optional HTTP(S) notification receiver |
| `WEBHOOK_TOKEN` | Unset | Optional webhook bearer token |
| `TINY_SENTRY_URL` | `http://localhost:3000` | CLI target; not used by the server |

Retention runs at startup, hourly, and after ingestion. The oldest events are removed first; groups disappear when no retained events remain. Counts on an existing group include pruned occurrences. Deleted SQLite pages are reused; the database file does not automatically shrink. The page cap excludes WAL/SHM files and backups, so leave volume headroom. A full database returns HTTP 507 rather than acknowledging an unsaved error. The database must fit the configured cap at startup.

Limits protect small deployments; they do not provide abuse protection for a publicly known DSN. Requests with bad keys to a known project count against its rate limit. Sentry-compatible `429` responses include retry headers. Use edge access controls if you need stronger abuse protection. Management tokens have access to every project on this instance; there are no user accounts or per-project admin permissions.

## Privacy and backups

Common credential keys, email/IP fields, and header tuples are filtered recursively. Request bodies, cookies, and query strings are removed. Fields named `url` lose credentials, query strings, and fragments. This is a basic scrubber: arbitrary error messages, strings, stack locals, and custom fields can still contain sensitive data. Keep `sendDefaultPii: false` and use SDK `beforeSend` for your application's redaction rules.

Use Railway volume backups, or run a consistent SQLite backup **inside the deployed container**, with enough free volume space:

```sh
bun src/cli.ts backup /data/tiny-sentry-backup.sqlite
```

The destination must not already exist. Copy the backup off the service for disaster recovery. A live database uses SQLite WAL; copying only the main live `.sqlite` file can lose recent writes. To restore, stop the service, replace the database with the backup, remove any old `-wal`/`-shm` sidecars, and restart. Keep a copy before replacing anything. A local `bun run cli backup ...` backs up your local `DB_PATH`, regardless of `TINY_SENTRY_URL`.

## Development and verification

```sh
bun run check
docker build -t tiny-sentry:verify .
bun run test:container
```

Tests exercise the HTTP protocol, authentication and privacy boundaries, grouping and regression handling, pagination, retention, database reopen, and consistent backups. The container check verifies Linux startup, network body limits, graceful stop, and persistence across container recreation. CI runs both. The real-SDK smoke checks described above used temporary installations outside this repository; Sentry SDKs are not service dependencies.

MIT licensed. This project is independent of Sentry and is not affiliated with or endorsed by Sentry.
