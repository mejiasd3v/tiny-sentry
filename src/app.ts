import { timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import type { Config } from "./config";
import { prepareEvent, type PreparedEvent } from "./event";
import { createIngestor } from "./ingestion";
import { parseEnvelope, parseObject, readBody, type JsonObject } from "./protocol";
import { Store, type Notice } from "./store";

function equal(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function pagination(c: Context) {
  const limit = Number(c.req.query("limit") ?? 25);
  const offset = Number(c.req.query("offset") ?? 0);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) {
    throw new HTTPException(400, { message: "limit must be 1-100; offset must be a nonnegative integer" });
  }
  return { limit, offset };
}

function issueId(c: Context) {
  const id = Number(c.req.param("id"));
  if (!Number.isSafeInteger(id) || id < 1) throw new HTTPException(400, { message: "Invalid issue ID" });
  return id;
}

export function createApp(config: Config, store: Store) {
  const app = new Hono();
  const persist = createIngestor(store, config.maxRequestBytes * 2);
  const buckets = new Map<string, { window: number; count: number }>();
  let webhooks = 0;

  async function notify(notices: Notice[]) {
    for (const notice of notices) {
      console.log(JSON.stringify({ type: notice.kind, project: notice.issue.project_id, issue_id: notice.issue.id }));
      if (!config.webhookUrl) continue;
      if (webhooks >= 4) {
        console.error(JSON.stringify({ type: "webhook_skipped", issue_id: notice.issue.id, reason: "concurrency_limit" }));
        continue;
      }
      webhooks++;
      try {
        const response = await fetch(config.webhookUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(config.webhookToken ? { authorization: `Bearer ${config.webhookToken}` } : {}),
          },
          body: JSON.stringify(notice), signal: AbortSignal.timeout(5000), redirect: "error",
        });
        await response.body?.cancel();
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
      } catch {
        // Do not log the webhook URL/token or make successful ingestion retry.
        console.error(JSON.stringify({ type: "webhook_failed", issue_id: notice.issue.id }));
      } finally { webhooks--; }
    }
  }

  app.onError((error, c) => {
    if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
    const code = "code" in error ? String(error.code) : "UNKNOWN";
    console.error(JSON.stringify({ type: "request_failed", code }));
    if (code === "SQLITE_FULL") return c.json({ error: "Storage limit reached" }, 507);
    return c.json({ error: "Internal server error" }, 500);
  });

  app.get("/", (c) => c.json({ name: "tiny-sentry", docs: "https://github.com/mejiasd3v/tiny-sentry" }));
  app.get("/health", (c) => {
    try { store.healthy(); return c.json({ status: "ok" }); }
    catch { return c.json({ status: "unavailable" }, 503); }
  });

  // CORS applies only to public SDK endpoints, never the management API.
  const ingestionCors = cors({
    origin: "*", allowMethods: ["POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Content-Encoding", "X-Sentry-Auth"],
    exposeHeaders: ["X-Sentry-Rate-Limits", "Retry-After"], maxAge: 86400,
  });
  app.use("/api/:project/envelope/*", ingestionCors);
  app.use("/api/:project/store/*", ingestionCors);

  async function ingest(c: Context) {
    const project = c.req.param("project") ?? "";
    const expected = Object.hasOwn(config.projects, project) ? config.projects[project] : undefined;
    if (!expected) throw new HTTPException(401, { message: "Invalid project or key" });
    const window = Math.floor(Date.now() / 60_000);
    let bucket = buckets.get(project);
    if (!bucket || bucket.window !== window) { bucket = { window, count: 0 }; buckets.set(project, bucket); }
    // Count every request to a known project, including bad keys, to bound work.
    if (++bucket.count > config.rateLimitPerMinute) {
      const retry = Math.max(1, 60 - Math.floor(Date.now() / 1000) % 60);
      c.header("Retry-After", String(retry));
      c.header("X-Sentry-Rate-Limits", `${retry}::organization`);
      return c.json({ error: "Rate limit exceeded" }, 429);
    }
    const bytes = await readBody(c.req.raw, config.maxRequestBytes);
    const envelope = c.req.path.replace(/\/$/, "").endsWith("/envelope") ? parseEnvelope(bytes) : null;
    let key = c.req.query("sentry_key");
    const auth = c.req.header("X-Sentry-Auth");
    if (auth) key = /(?:^Sentry\s+|,\s*)sentry_key\s*=\s*([^,\s]+)/i.exec(auth)?.[1];
    if (envelope?.headers.dsn !== undefined) {
      try {
        const dsn = new URL(String(envelope.headers.dsn));
        if (dsn.pathname.replace(/\/$/, "").split("/").at(-1) !== project || (key && key !== dsn.username)) {
          throw new Error("DSN mismatch");
        }
        key ??= dsn.username;
      } catch { throw new HTTPException(401, { message: "Invalid envelope DSN" }); }
    }
    if (!key || !equal(key, expected)) throw new HTTPException(401, { message: "Invalid project or key" });
    const inputs: JsonObject[] = envelope ? envelope.events : [parseObject(bytes)];
    const events: PreparedEvent[] = [];
    for (const input of inputs) {
      const event = prepareEvent(input, config.maxEventBytes);
      if (event) events.push(event);
    }
    const notices = await persist(project, events);
    void notify(notices);
    return c.json({ id: events[0]?.id ?? null });
  }
  app.post("/api/:project/envelope", ingest);
  app.post("/api/:project/envelope/", ingest);
  app.post("/api/:project/store", ingest);
  app.post("/api/:project/store/", ingest);

  app.use("/api/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    const authorization = c.req.header("Authorization") ?? "";
    if (!equal(authorization, `Bearer ${config.adminToken}`)) {
      throw new HTTPException(401, { message: "Invalid admin token" });
    }
    await next();
  });

  app.get("/api/projects", (c) => c.json({ projects: Object.keys(config.projects).map((id) => ({ id })) }));
  app.get("/api/stats", (c) => c.json(store.stats()));
  app.get("/api/issues", (c) => {
    const { limit, offset } = pagination(c);
    const status = c.req.query("status") ?? null;
    if (status !== null && status !== "resolved" && status !== "unresolved") {
      throw new HTTPException(400, { message: "status must be resolved or unresolved" });
    }
    const issues = store.issues(c.req.query("project") ?? null, status, limit, offset);
    return c.json({ issues, limit, offset });
  });
  app.get("/api/issues/:id", (c) => {
    const issue = store.issue(issueId(c));
    if (!issue) throw new HTTPException(404, { message: "Issue not found" });
    const latest = store.events(issue.id, 1, 0)[0];
    return c.json({ issue, latest_event: latest ? store.event(issue.project_id, latest.event_id) : null });
  });
  app.get("/api/issues/:id/events", (c) => {
    const id = issueId(c);
    if (!store.issue(id)) throw new HTTPException(404, { message: "Issue not found" });
    const { limit, offset } = pagination(c);
    return c.json({ events: store.events(id, limit, offset), limit, offset });
  });
  app.patch("/api/issues/:id", async (c) => {
    const body = parseObject(await readBody(c.req.raw, 4096));
    if (body.status !== "resolved" && body.status !== "unresolved") {
      throw new HTTPException(400, { message: "status must be resolved or unresolved" });
    }
    const issue = store.setStatus(issueId(c), body.status);
    if (!issue) throw new HTTPException(404, { message: "Issue not found" });
    return c.json({ issue });
  });
  app.get("/api/projects/:project/events/:event", (c) => {
    const event = store.event(c.req.param("project"), c.req.param("event").toLowerCase());
    if (!event) throw new HTTPException(404, { message: "Event not found" });
    return c.json(event);
  });
  app.notFound((c) => c.json({ error: "Not found" }, 404));
  return app;
}
