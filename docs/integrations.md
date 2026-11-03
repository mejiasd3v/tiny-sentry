# Optional integrations

Integrations turn errors into issues or notifications. They run inside tiny-sentry, use its existing SQLite database, and add no dependencies or services. They are off until `INTEGRATIONS` contains at least one rule.

## Configure a rule

Set `INTEGRATIONS` to a JSON array in Railway's service variables, or a single-quoted JSON value in your local `.env`. Store credentials in separate server environment variables. Restart after changing either.

For example, create a GitHub issue when a group reaches ten occurrences, and send each new group to Discord:

```json
[
  {
    "id": "github-after-ten",
    "type": "github",
    "projects": ["1"],
    "levels": ["error", "fatal"],
    "trigger": { "type": "threshold", "count": 10 },
    "options": {
      "repository": "mejiasd3v/my-project",
      "tokenEnv": "GITHUB_ISSUES_TOKEN"
    }
  },
  {
    "id": "discord-new-errors",
    "type": "discord",
    "projects": ["1"],
    "trigger": { "type": "new_issue" },
    "options": { "urlEnv": "DISCORD_WEBHOOK_URL" }
  }
]
```

Also set `GITHUB_ISSUES_TOKEN` and `DISCORD_WEBHOOK_URL`. The server validates rules and provider options before listening. Missing credentials, unknown options/types, and malformed rules fail startup without printing their values.

Each rule has a unique `id` (1–64 letters, digits, `_` or `-`), one provider `type`, one `trigger`, and provider `options`. `projects` and `levels` are optional nonempty arrays. Omitting either matches all projects or all levels. Project IDs must exist in `SENTRY_PROJECTS`; levels match the SDK's level strings exactly. Up to 32 rules are supported.

Use separate IDs to configure several triggers or destinations, even for the same provider. Remove a rule to disable it; use `[]` or unset `INTEGRATIONS` to disable all integrations. No provider credentials go in a client DSN.

## Triggers

| Trigger | When a delivery is queued |
| --- | --- |
| `{"type":"new_issue"}` | The first unique event creates a group |
| `{"type":"regression"}` | A new unique event reopens a resolved group |
| `{"type":"threshold","count":10}` | A group's lifetime occurrence count becomes exactly 10 |

Rules run on each newly accepted event, including individual events inside one envelope or shared transaction. A repeated event ID does not count while it remains retained. The summary captures the issue at the triggering event, rather than the end of the envelope. Filters must match that event's project and level.

A threshold fires once in an issue's lifetime. Resolving or reopening does not reset its count. It is not a rolling rate such as ten errors in five minutes, and adding a rule does not inspect or backfill old events. If a group has already passed ten, a newly added threshold of ten does not fire. Grouping spans environments; environment filters are not implemented.

Existing retention semantics apply: counts include pruned occurrences while the group exists. Once all its events expire, the group disappears. A later occurrence creates a new group and starts its count again. Event IDs can also count again after their stored event expires.

## Providers

Examples below are the `options` object of a rule. Every provider receives only an issue summary: trigger kind, issue/project IDs, title, fingerprint, level, status, timestamps, and occurrence count. Raw events, stack traces, request data, public keys, and admin tokens are not included. Titles can still contain sensitive application strings; apply SDK `beforeSend` redaction as needed.

### GitHub

```json
{"repository":"owner/repository","tokenEnv":"GITHUB_ISSUES_TOKEN"}
```

Creates a new GitHub issue through `POST /repos/{owner}/{repo}/issues`. Use a fine-grained personal access token restricted to that repository with **Issues: read and write**. Issues must be enabled. Title and description include the tiny-sentry summary. GitHub.com is supported; GitHub Enterprise hosts are not configured by this adapter.

### Linear

```json
{"teamId":"your-team-uuid","tokenEnv":"LINEAR_API_KEY"}
```

Creates an issue through Linear's `issueCreate` GraphQL mutation. Use a Linear API key with permission to create issues in that team; `teamId` is the team's UUID, not its display name. Set the environment variable to the API key itself. The adapter checks GraphQL errors even when HTTP returns 200.

### Jira Cloud

```json
{
  "baseUrl":"https://your-team.atlassian.net",
  "projectKey":"APP",
  "issueTypeId":"10001",
  "emailEnv":"JIRA_EMAIL",
  "tokenEnv":"JIRA_API_TOKEN"
}
```

Creates an issue through Jira Cloud's `/rest/api/3/issue`, using email/API-token Basic authentication and an Atlassian Document Format description. Use an API token accepted by your site's direct REST endpoint and an account with permission to create issues in the selected project. Obtain an issue type ID supported by that project. Sites requiring additional mandatory fields need a custom plugin. Jira Data Center and scoped tokens requiring Atlassian's gateway URL are outside this adapter's scope. `baseUrl` must be an HTTPS origin without a path or query.

### Telegram

```json
{"tokenEnv":"TELEGRAM_BOT_TOKEN","chatId":"-1001234567890"}
```

Sends a plain-text message through Bot API `sendMessage`. Create a bot with BotFather, then start a conversation with it or add it to the target group/channel with posting permission. Set the destination chat ID as a string. There is no Markdown/HTML parse mode, and link previews are disabled.

### Discord

```json
{"urlEnv":"DISCORD_WEBHOOK_URL"}
```

Create a channel webhook and store its full `https://discord.com/api/webhooks/...` URL in the named environment variable. Sends a text message with automatic mentions disabled, so error text containing `@everyone` cannot page the channel. Requests use `wait=true` to wait for Discord's confirmation. The built-in adapter accepts canonical Discord.com webhook URLs without trailing slashes.

### Custom webhook

```json
{
  "url":"https://your-receiver.example/errors",
  "tokenEnv":"ERROR_WEBHOOK_TOKEN",
  "signingSecretEnv":"ERROR_WEBHOOK_SECRET"
}
```

`tokenEnv` and `signingSecretEnv` are optional. Set exactly one of `url` or `urlEnv`; use `urlEnv` if the URL itself contains a secret. HTTP and HTTPS are supported, including private-network receivers. Destination URLs are trusted administrator configuration. Redirects are rejected for every built-in provider.

Receives a JSON POST:

```json
{
  "kind":"threshold",
  "issue":{
    "id":42,
    "project_id":"1",
    "fingerprint":"...",
    "title":"TypeError: Something broke",
    "level":"error",
    "status":"unresolved",
    "first_seen":1793692800000,
    "last_seen":1793692801000,
    "event_count":10
  }
}
```

`Idempotency-Key` is the delivery UUID and stays identical across automatic and manual retries. Receivers should deduplicate successful processing by this key. `tokenEnv` adds `Authorization: Bearer ...`.

If signing is enabled, `X-Tiny-Sentry-Signature` is `t=<unix-seconds>,v1=<hex-hmac-sha256>`. Compute HMAC-SHA256 with the signing secret over `timestamp + "." + raw_request_body`, compare in constant time, and reject stale timestamps (for example, older than five minutes). Signatures use the current timestamp on each attempt; the delivery key remains stable. Use HTTPS for public endpoints.

Any HTTP 2xx response acknowledges a webhook. Handle processing durably before returning 2xx, or queue it durably on the receiving side.

## Delivery, retries, and limits

The implementation has three parts:

1. The store evaluates rules and inserts delivery summaries **inside the event transaction**. A failed commit leaves neither events nor deliveries. Ingestion waits for this commit, then wakes the dispatcher.
2. The dispatcher claims one job with a 30-second lease and performs a provider request with a ten-second timeout. It runs inside the server process, outside ingestion. When nothing is queued, it has no polling timer. Startup resumes persisted work.
3. A plugin validates its options at startup and implements `send(notification, context)`. It does not own triggers, persistence, or retries.

Delivery is bounded **at least once**, with up to six automatic attempts. Network failures, timeouts, HTTP 408/425/429/5xx, and recognized provider rate limits retry. Other HTTP 4xx failures are permanent. Backoff starts at one second and doubles; a longer `Retry-After` takes precedence, capped at 24 hours. GitHub rate-limit reset headers, Linear `RATELIMITED` errors, and Telegram retry delays are also handled. Provider failure does not undo an accepted event. Shutdown aborts the active request and keeps retryable work in SQLite.

If a provider accepts a request but its response is lost, or the process dies before recording success, a retry can create a duplicate issue/message. GitHub, Linear, Jira, Telegram, and Discord do not get an exactly-once guarantee. Manual retries carry the same risk. There is no searching for an existing external issue, updating its occurrence count, automatic closing/reopening, two-way synchronization, or storage of external issue IDs.

`MAX_DELIVERIES` defaults to **1,000 rows**, including pending work and recent terminal history. At capacity, the oldest delivered/failed/cancelled row is removed to make space. If every row is pending or being delivered, new matching notifications are dropped, ingestion continues, and a persistent `dropped` counter increments. Dropped notifications are not replayed. Preserve important failures outside this bounded history before they are evicted. Lowering the cap does not delete active jobs.

The queue is part of `MAX_DB_MB` and shares the volume/backup with errors. A full SQLite database still rejects the event transaction with HTTP 507. Queue summaries survive issue retention and therefore can include the title of an issue already pruned from the event store. Terminal history has a count cap, not an age expiry. The queue contains no resolved environment-secret values; it stores a configuration hash rather than options.

Editing any rule changes its configuration hash. On restart, pending/in-flight jobs from removed or edited rules are cancelled. They cannot be retargeted or manually retried. Rotating only the value of a referenced secret keeps the rule unchanged and pending jobs use the new secret. Renaming a secret reference changes the rule. Configuration is static until restart; run one replica and stop the old process before replacing its configuration.

On Railway, keep the existing `/data` volume. No additional service is required. If delivery timing matters, keep the service awake: server sleep can postpone retries until the next wake. The no-integrations configuration starts no dispatcher. Enabled rules add transactional queue writes, outbound connections, and retained summaries; earlier benchmark/memory figures predate this system and do not measure that overhead.

## Inspect and retry

```sh
bun run cli integrations
bun run cli deliveries --limit 25 --offset 0
bun run cli retry-delivery <delivery-uuid>
```

These management endpoints require the existing admin bearer token:

| Method | Path | Result |
| --- | --- | --- |
| GET | `/api/integrations` | Rule metadata without options, counts by status, persistent overflow count |
| GET | `/api/integrations/deliveries?limit=25&offset=0` | Delivery IDs, issue IDs, trigger kinds, status, attempts, and timestamps |
| POST | `/api/integrations/deliveries/:id/retry` | Reset a failed job to pending with the same delivery ID |

Only a failed job whose rule is still configured and unchanged can be retried; otherwise the retry endpoint returns 409. Listings never include credentials, destinations, payloads, configuration hashes, or provider response bodies. Structured logs record delivery ID, rule ID, attempt, outcome, and HTTP failure status when available, without raw errors or credentials. Statuses are `pending`, `delivering`, `delivered`, `failed`, and `cancelled`.

## Write a local plugin

Set `INTEGRATIONS_MODULE=./src/custom-integrations.ts`. That local TypeScript file must default-export a map of new provider names to `IntegrationPlugin` objects. Built-in types cannot be overridden. No module is loaded unless at least one rule is enabled. Module initialization must not send notifications.

For example, an ntfy plugin:

```ts
// src/custom-integrations.ts
import { DeliveryError, type IntegrationPlugin } from "./integrations/types";

const ntfy: IntegrationPlugin = {
  create(options, env) {
    if (typeof options.url !== "string") throw new Error("url required");
    const url = new URL(options.url);
    if (url.protocol !== "https:") throw new Error("HTTPS required");
    const token = env.NTFY_TOKEN;
    if (!token) throw new Error("NTFY_TOKEN required");
    return {
      async send({ kind, issue }, { signal, idempotencyKey }) {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Idempotency-Key": idempotencyKey,
          },
          body: `${kind}: ${issue.title} (project ${issue.project_id}, issue ${issue.id})`,
          signal,
          redirect: "error",
        });
        await response.body?.cancel();
        if (!response.ok) throw new DeliveryError(response.status === 429 || response.status >= 500);
      },
    };
  },
};

export default { ntfy };
```

Configure a rule with `"type":"ntfy"` and `"options":{"url":"https://ntfy.example/my-errors"}`. The Dockerfile includes files under `src`, so placing the module there includes it in the Railway image. Other locations need an explicit Dockerfile copy.

Plugins execute as trusted server code with filesystem, environment, and network access. There is no downloaded plugin marketplace or sandbox. Validate options in `create`, honor `context.signal`, release response bodies, and throw `DeliveryError(false)` for permanent failures. `DeliveryError(true, delayMs)` asks for a retry after at least that delay. Other thrown errors are treated as transient, and raw error text is not logged. A plugin that ignores cancellation can continue its side effect after a timeout; only install code you control. Provider rate limits, retries, and duplicate handling remain your responsibility at the external boundary.

## Verification scope

Tests cover SDK ingestion through the outbox, exact trigger snapshots, project/level filters, deduplication, transactional rollback, capacity overflow, retention independence, restart leases, stale completions, attempt limits, rule changes, authenticated status/retry endpoints, webhook signing and retry delivery through a real local HTTP listener, shutdown cancellation, and a local TypeScript plugin. Adapter tests verify the five vendor request formats and logical response errors with simulated remote responses. They do not prove acceptance by live provider accounts or a particular workspace's permissions/required fields.
