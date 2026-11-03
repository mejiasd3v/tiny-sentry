import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { createApp } from "../src/app";
import { loadConfig, type Config } from "../src/config";
import { Store } from "../src/store";

const key = "a".repeat(32);
const admin = "b".repeat(64);
const secondKey = "c".repeat(32);
const stores: Store[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(overrides: Partial<Config> = {}) {
  const config = {
    ...loadConfig({ ADMIN_TOKEN: admin, SENTRY_PROJECTS: JSON.stringify({ "1": key, "2": secondKey }), DB_PATH: ":memory:" }),
    ...overrides,
  };
  const store = new Store(config);
  stores.push(store);
  const app = createApp(config, store);
  return {
    config, store, app,
    send: (event: Record<string, unknown>, project = "1") => app.request(`/api/${project}/store/?sentry_key=${project === "1" ? key : secondKey}`, {
      method: "POST", body: JSON.stringify(event),
    }),
    api: (path: string, init: RequestInit = {}) => app.request(`/api${path}`, {
      ...init, headers: { Authorization: `Bearer ${admin}`, ...init.headers },
    }),
  };
}

function event(id = "1".repeat(32), value = "Missing record 12") {
  return {
    event_id: id, platform: "javascript", environment: "production", release: "web@1.0.0",
    exception: { values: [{ type: "TypeError", value, stacktrace: { frames: [
      { filename: "app.ts", function: "findRecord", lineno: 42, in_app: true },
    ] } }] },
  };
}

function envelope(items: { type: string; body: string | Uint8Array; length?: boolean }[], headers: Record<string, unknown> = {}) {
  const parts: Uint8Array[] = [Buffer.from(`${JSON.stringify(headers)}\n`)];
  for (const item of items) {
    const bytes = typeof item.body === "string" ? Buffer.from(item.body) : item.body;
    parts.push(Buffer.from(`${JSON.stringify({ type: item.type, ...(item.length ? { length: bytes.length } : {}) })}\n`), bytes, Buffer.from("\n"));
  }
  return Buffer.concat(parts);
}

describe("Sentry transport compatibility", () => {
  test("accepts query, X-Sentry-Auth and envelope DSN authentication with browser CORS", async () => {
    const { app, api } = fixture();
    for (const auth of ["query", "header", "dsn"]) {
      const body = envelope([{ type: "event", body: JSON.stringify({ message: auth }) }],
        auth === "dsn" ? { dsn: `https://${key}@errors.example/1` } : {});
      const response = await app.request(`/api/1/envelope${auth === "query" ? `/?sentry_key=${key}` : ""}`, {
        method: "POST", body,
        headers: { Origin: "https://myapp.example", ...(auth === "header" ? { "X-Sentry-Auth": `Sentry sentry_version=7, sentry_client=test/1.0, sentry_key=${key}` } : {}) },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect((await response.json()).id).toMatch(/^[a-f\d]{32}$/);
    }
    const preflight = await app.request("/api/1/envelope/", { method: "OPTIONS", headers: { Origin: "https://app.example", "Access-Control-Request-Headers": "X-Sentry-Auth" } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-headers")).toContain("X-Sentry-Auth");
    expect(await (await api("/stats")).json()).toEqual({ events: 3, issues: 3 });
  });

  test("skips byte-counted binary and performance items while preserving Unicode error events", async () => {
    const { app, api } = fixture();
    const id = "a1".repeat(16);
    const body = envelope([
      { type: "attachment", body: new Uint8Array([0, 10, 255, 10, 123, 125]), length: true },
      { type: "transaction", body: JSON.stringify({ transaction: "GET /" }) },
      { type: "event", body: JSON.stringify({ message: "Falló la conexión 🐛", breadcrumbs: [{ message: "one\ntwo" }] }, null, 2), length: true },
      { type: "session", body: "{}" },
    ], { event_id: id });
    const response = await app.request(`/api/1/envelope/?sentry_key=${key}`, { method: "POST", body });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id });
    const saved = await (await api(`/projects/1/events/${id}`)).json();
    expect(saved.event.message).toBe("Falló la conexión 🐛");
    expect(saved.event.breadcrumbs[0].message).toBe("one\ntwo");
    expect(await (await api("/stats")).json()).toEqual({ events: 1, issues: 1 });
  });

  test.each(["gzip", "deflate"])("accepts %s compression with a bounded decompressed size", async (encoding) => {
    const { app, api } = fixture({ maxRequestBytes: 2048 });
    const compress = encoding === "gzip" ? Bun.gzipSync : deflateSync;
    const response = await app.request(`/api/1/store/?sentry_key=${key}`, {
      method: "POST", headers: { "content-encoding": encoding }, body: compress(Buffer.from(JSON.stringify(event()))),
    });
    expect(response.status).toBe(200);
    const bomb = compress(Buffer.from(JSON.stringify({ message: "x".repeat(10000) })));
    const tooBig = await app.request(`/api/1/store/?sentry_key=${key}`, { method: "POST", headers: { "content-encoding": encoding }, body: bomb });
    expect(tooBig.status).toBe(413);
    expect(await (await api("/stats")).json()).toEqual({ events: 1, issues: 1 });
  });

  test("rejects malformed envelopes and invalid events without partial writes", async () => {
    const { app, api } = fixture();
    const bodies = [
      "{}\n{\"type\":\"event\",\"length\":999}\n{}",
      "{}\n{\"type\":\"event\",\"length\":2}\n{}garbage",
      "{}\nnot-json\n{}",
      envelope([{ type: "event", body: JSON.stringify(event()) }, { type: "event", body: '{"event_id":"bad"}' }]),
      envelope([{ type: "event", body: '{"fingerprint":[]}' }]),
    ];
    for (const body of bodies) {
      const response = await app.request(`/api/1/envelope/?sentry_key=${key}`, { method: "POST", body });
      expect(response.status).toBe(400);
    }
    expect(await (await api("/stats")).json()).toEqual({ events: 0, issues: 0 });
  });
});

describe("authentication, limits and privacy", () => {
  test("rejects cross-project keys, DSN mismatches and public access to management endpoints", async () => {
    const { app, send, api } = fixture();
    for (const path of ["/api/issues", "/api/projects", "/api/stats", "/api/issues/1", "/api/issues/1/events", "/api/projects/1/events/" + "1".repeat(32)]) {
      const response = await app.request(path, { headers: { Authorization: `Bearer ${key}` } });
      expect(response.status).toBe(401);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }
    for (const path of [`/api/2/store/?sentry_key=${key}`, "/api/1/store/", `/api/999/store/?sentry_key=${key}`]) {
      expect((await app.request(path, { method: "POST", body: JSON.stringify(event()) })).status).toBe(401);
    }
    const mismatch = envelope([], { dsn: `https://${key}@errors.example/2` });
    expect((await app.request(`/api/1/envelope/?sentry_key=${key}`, { method: "POST", body: mismatch })).status).toBe(401);
    expect((await send(event())).status).toBe(200);
    const duplicateOtherProject = await send(event(), "2");
    expect(duplicateOtherProject.status).toBe(200);
    expect((await (await api("/issues?project=2")).json()).issues).toHaveLength(1);
  });

  test("scrubs common credentials, PII, request bodies and URL query strings before persistence", async () => {
    const { send, api } = fixture();
    await send({ ...event(),
      user: { id: "user-1", email: "private@example.com", ip_address: "192.0.2.1" },
      request: { url: "https://user:pass@example.com/path?access_token=private#secret", data: "private-body", cookies: "private-cookie", query_string: "private-query", headers: { Authorization: "private-auth", "X-Safe": "safe" } },
      extra: { password: "private-password", nested: { access_token: "private-token", apiKey: "private-key" } },
      breadcrumbs: [{ data: { headers: [["cookie", "private-cookie"]] } }],
    });
    const response = await api(`/projects/1/events/${"1".repeat(32)}`);
    const serialized = await response.text();
    expect(serialized).not.toContain("private");
    expect(serialized).not.toContain("192.0.2.1");
    const saved = JSON.parse(serialized).event;
    expect(saved.request.url).toBe("https://example.com/path");
    expect(saved.request.headers["X-Safe"]).toBe("safe");
    expect(saved.user.id).toBe("user-1");
  });

  test("returns Sentry retry headers at the project limit without blocking other projects", async () => {
    const { send, api } = fixture({ rateLimitPerMinute: 1 });
    expect((await send(event())).status).toBe(200);
    const limited = await send(event("2".repeat(32)));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(limited.headers.get("X-Sentry-Rate-Limits")).toMatch(/^\d+::organization$/);
    expect((await send(event(), "2")).status).toBe(200);
    expect((await api("/stats")).status).toBe(200);
  });

  test("rejects oversized requests/events and unknown compression without acknowledging writes", async () => {
    const { app, send, api } = fixture({ maxRequestBytes: 2048, maxEventBytes: 512 });
    expect((await send({ message: "x".repeat(600) })).status).toBe(413);
    expect((await send({ message: "x".repeat(3000) })).status).toBe(413);
    expect((await app.request(`/api/1/store/?sentry_key=${key}`, { method: "POST", headers: { "Content-Encoding": "br" }, body: "{}" })).status).toBe(415);
    expect((await app.request(`/api/1/store/?sentry_key=${key}`, { method: "POST", headers: { "Content-Encoding": "gzip" }, body: "broken" })).status).toBe(400);
    expect(await (await api("/stats")).json()).toEqual({ events: 0, issues: 0 });
  });
});

describe("issue lifecycle and durable storage", () => {
  test("deduplicates event IDs, groups changing messages, and reopens resolved issues", async () => {
    const { send, api } = fixture();
    await send(event());
    await send(event());
    let issues = (await (await api("/issues")).json()).issues;
    expect(issues).toHaveLength(1);
    expect(issues[0].event_count).toBe(1);
    const id = issues[0].id;
    expect((await api(`/issues/${id}`, { method: "PATCH", body: '{"status":"resolved"}' })).status).toBe(200);
    await send(event()); // A retried delivery must not reopen an issue.
    expect((await (await api(`/issues/${id}`)).json()).issue.status).toBe("resolved");
    await send(event("2".repeat(32), "Missing record 99"));
    issues = (await (await api("/issues?status=unresolved")).json()).issues;
    expect(issues).toHaveLength(1);
    expect(issues[0].id).toBe(id);
    expect(issues[0].event_count).toBe(2);
    const detail = await (await api(`/issues/${id}`)).json();
    expect(detail.latest_event.event.event_id).toBe("2".repeat(32));
    expect((await (await api(`/issues/${id}/events?limit=1&offset=1`)).json()).events[0].event_id).toBe("1".repeat(32));
  });

  test("honors custom fingerprints and separates projects", async () => {
    const { send, api } = fixture();
    await send({ ...event(), fingerprint: ["billing"] });
    await send({ ...event("2".repeat(32)), fingerprint: ["billing"] });
    await send({ ...event("3".repeat(32)), fingerprint: ["search", "{{ default }}"] });
    await send({ ...event(), fingerprint: ["billing"] }, "2");
    const issues = (await (await api("/issues")).json()).issues;
    expect(issues).toHaveLength(3);
    expect(issues.find((issue: { project_id: string; event_count: number }) => issue.project_id === "1" && issue.event_count === 2)).toBeDefined();
  });

  test("survives database reopen and creates a consistent independent backup", async () => {
    const directory = mkdtempSync(join(tmpdir(), "tiny-sentry-"));
    directories.push(directory);
    const { send, store, config } = fixture({ dbPath: join(directory, "data.sqlite") });
    await send(event());
    const backupPath = join(directory, "backup.sqlite");
    store.backup(backupPath);
    store.close();
    stores.splice(stores.indexOf(store), 1);
    for (const dbPath of [config.dbPath, backupPath]) {
      const reopened = fixture({ dbPath });
      expect(await (await reopened.api("/stats")).json()).toEqual({ events: 1, issues: 1 });
      expect((await (await reopened.api(`/projects/1/events/${"1".repeat(32)}`)).json()).event.environment).toBe("production");
    }
  });

  test("bounds global event count and expires inactive groups using server receive time", async () => {
    const { send, api, store } = fixture({ maxEvents: 2, retentionDays: 1 });
    for (let id = 1; id <= 3; id++) await send({ event_id: String(id).repeat(32), message: `message-${id}`, timestamp: 0 });
    expect(await (await api("/stats")).json()).toEqual({ events: 2, issues: 2 });
    expect((await api(`/projects/1/events/${"1".repeat(32)}`)).status).toBe(404);
    expect((await api(`/projects/1/events/${"3".repeat(32)}`)).status).toBe(200);
    store.prune(Date.now() + 86_400_001);
    expect(await (await api("/stats")).json()).toEqual({ events: 0, issues: 0 });
  });

  test("validates management parameters and reports missing resources", async () => {
    const { api } = fixture();
    for (const path of ["/issues?status=ignored", "/issues?limit=101", "/issues?offset=-1", "/issues/NaN"]) expect((await api(path)).status).toBe(400);
    expect((await api("/issues/1")).status).toBe(404);
    expect((await api("/issues/1/events")).status).toBe(404);
    expect((await api("/issues/1", { method: "PATCH", body: '{"status":"ignored"}' })).status).toBe(400);
  });

  test("returns 507 on a full database and rolls back the unacknowledged occurrence", async () => {
    const { send, api } = fixture({ maxDbMb: 1 });
    let full = false;
    let accepted = 0;
    for (let index = 0; index < 40; index++) {
      const id = index.toString(16).padStart(32, "0");
      const response = await send({ event_id: id, message: "storage boundary", extra: { payload: "x".repeat(50_000) } });
      if (response.status === 507) {
        full = true;
        expect((await api(`/projects/1/events/${id}`)).status).toBe(404);
        break;
      }
      expect(response.status).toBe(200);
      accepted++;
    }
    expect(full).toBe(true);
    expect(await (await api("/stats")).json()).toEqual({ events: accepted, issues: 1 });
    expect((await (await api("/issues")).json()).issues[0].event_count).toBe(accepted);
  });

  test("notifies new issues and regressions; a failing webhook does not reject ingestion", async () => {
    const deliveries: { kind: string; authorization: string | null }[] = [];
    let received = Promise.withResolvers<void>();
    const receiver = Bun.serve({
      port: 0,
      async fetch(request) {
        const payload = await request.json() as { kind: string };
        deliveries.push({ kind: payload.kind, authorization: request.headers.get("authorization") });
        received.resolve();
        return new Response("unavailable", { status: 503 });
      },
    });
    try {
      const { send, api } = fixture({ webhookUrl: `http://localhost:${receiver.port}`, webhookToken: "receiver-token" });
      expect((await send(event())).status).toBe(200);
      await Promise.race([received.promise, Bun.sleep(2000).then(() => { throw new Error("Webhook not received"); })]);
      await api("/issues/1", { method: "PATCH", body: '{"status":"resolved"}' });
      await send(event());
      received = Promise.withResolvers<void>();
      expect((await send(event("2".repeat(32)))).status).toBe(200);
      await Promise.race([received.promise, Bun.sleep(2000).then(() => { throw new Error("Regression webhook not received"); })]);
      expect(deliveries).toEqual([
        { kind: "new_issue", authorization: "Bearer receiver-token" },
        { kind: "regression", authorization: "Bearer receiver-token" },
      ]);
      expect(await (await api("/stats")).json()).toEqual({ events: 2, issues: 1 });
    } finally { await receiver.stop(true); }
  });
});
