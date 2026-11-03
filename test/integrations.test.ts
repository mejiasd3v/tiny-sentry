import { afterEach, expect, spyOn, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { prepareEvent } from "../src/event";
import { leaseMs, maxAttempts } from "../src/integrations/outbox";
import { builtinPlugins } from "../src/integrations/plugins";
import { createDispatcher, loadDeliveries } from "../src/integrations/runtime";
import { DeliveryError, type Notification } from "../src/integrations/types";
import { Store } from "../src/store";

const admin = "a".repeat(32);
const key = "b".repeat(32);
const stores = new Set<Store>();
const directories: string[] = [];
const workers: ReturnType<typeof createDispatcher>[] = [];
afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.stop();
  for (const store of stores) store.close();
  stores.clear();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function settings(rules: unknown[] = [], env: Record<string, string> = {}) {
  return loadConfig({ ADMIN_TOKEN: admin, SENTRY_PROJECTS: JSON.stringify({ "1": key, "2": key }),
    DB_PATH: ":memory:", INTEGRATIONS: JSON.stringify(rules), ...env });
}

function rule(id = "hook", trigger: unknown = { type: "new_issue" }) {
  return { id, type: "webhook", trigger, options: { url: "https://receiver.example/errors" } };
}

function open(config: ReturnType<typeof settings>) {
  const store = new Store(config);
  stores.add(store);
  return store;
}

function event(id: number, group = "shared", level = "error") {
  return { event_id: id.toString(16).padStart(32, "0"), message: group, fingerprint: [group], level };
}

async function send(app: ReturnType<typeof createApp>, input: Record<string, unknown>, project = "1") {
  return app.request(`/api/${project}/store/?sentry_key=${key}`, { method: "POST", body: JSON.stringify(input) });
}

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Delivery did not reach its expected state");
    await Bun.sleep(5);
  }
}

test("configuration defaults to off and rejects ambiguous triggers, duplicate rules and missing credentials", async () => {
  expect(settings().integrations).toEqual([]);
  expect(await loadDeliveries(settings([], { INTEGRATIONS_MODULE: "/missing/unused.ts" }))).toEqual(new Map());
  for (const invalid of [
    [rule(), rule()], [rule("bad", { type: "threshold", count: 0 })],
    [rule("bad", { type: "threshold", count: 1, windowSeconds: 60 })],
    [{ ...rule(), projects: ["99"] }], [{ ...rule(), enabled: false }],
  ]) expect(() => settings(invalid)).toThrow();
  const secret = "do-not-include-this-secret-in-errors";
  const config = settings([{ ...rule(), options: { url: `https://${secret}.example`, tokenEnv: "MISSING" } }]);
  await expect(loadDeliveries(config, {})).rejects.toThrow("Cannot initialize integration hook");
  try { await loadDeliveries(config, {}); } catch (error) { expect(String(error)).not.toContain(secret); }
});

test("SDK ingestion enqueues exact new, threshold and regression snapshots with deduplication and project/level filters", async () => {
  const rules = [rule("new"), rule("tenth", { type: "threshold", count: 3 }), rule("again", { type: "regression" })]
    .map((entry) => ({ ...entry, projects: ["1"], levels: ["error", "fatal"] }));
  const config = settings(rules);
  const store = open(config);
  const app = createApp(config, store);
  const inputs = [event(1), event(2), event(2), event(3), event(4)];
  const envelope = `{}\n${inputs.map((input) => `{"type":"event"}\n${JSON.stringify(input)}\n`).join("")}`;
  expect((await app.request(`/api/1/envelope/?sentry_key=${key}`, { method: "POST", body: envelope })).status).toBe(200);
  const id = store.event("1", event(1).event_id)!.issue_id;
  store.setStatus(id, "resolved");
  await send(app, event(4)); // An already retained event must not regress the issue.
  expect(store.issue(id)?.status).toBe("resolved");
  await send(app, event(5));
  await send(app, event(6, "warning", "warning"));
  await send(app, event(7), "2");
  const jobs = [];
  for (let job = store.outbox.claim(); job; job = store.outbox.claim()) {
    jobs.push({ rule: job.integration_id, ...JSON.parse(job.payload) });
  }
  expect(jobs.map((job) => [job.rule, job.kind, job.issue.event_count])).toEqual([
    ["new", "new_issue", 1], ["tenth", "threshold", 3], ["again", "regression", 5],
  ]);
  expect(store.issue(id)?.event_count).toBe(5);
  const response = await app.request("/api/integrations", { headers: { Authorization: `Bearer ${admin}` } });
  expect(response.status).toBe(200);
  const serialized = await response.text();
  expect(serialized).not.toContain("receiver.example");
  expect(serialized).not.toContain("options");
  for (const path of ["/api/integrations", "/api/integrations/deliveries", "/api/integrations/deliveries/nope/retry"]) {
    expect((await app.request(path, { method: path.endsWith("retry") ? "POST" : "GET" })).status).toBe(401);
  }
});

test("a shared failed commit rolls back both errors and queued side effects", async () => {
  const config = settings([rule()], { MAX_DB_MB: "1", MAX_REQUEST_BYTES: "1048576" });
  const store = open(config);
  const app = createApp(config, store);
  const responses = await Promise.all(Array.from({ length: 32 }, (_, index) =>
    send(app, { ...event(index, `group-${index}`), extra: { payload: "x".repeat(50_000) } })));
  expect(responses.map((response) => response.status)).toEqual(Array(32).fill(507));
  expect(store.stats()).toEqual({ events: 0, issues: 0 });
  expect(store.outbox.list(100, 0)).toEqual([]);
  expect((await send(app, event(33))).status).toBe(200);
  expect(store.outbox.list(100, 0)).toHaveLength(1);
});

test("bounded outbox preserves pending jobs, counts overflow and reuses terminal history space", async () => {
  const config = settings([rule()], { MAX_DELIVERIES: "2", MAX_EVENTS: "1" });
  const store = open(config);
  const app = createApp(config, store);
  for (let id = 1; id <= 3; id++) expect((await send(app, event(id, `group-${id}`))).status).toBe(200);
  expect(store.outbox.stats()).toEqual({ dropped: 1, counts: [{ status: "pending", count: 2 }] });
  expect(store.stats()).toEqual({ events: 1, issues: 1 });
  // Queue summaries survive event/issue retention, without retaining the event payload.
  const job = store.outbox.claim()!;
  expect(JSON.parse(job.payload).issue.title).toBe("group-1");
  store.outbox.finish(job, "delivered", Date.now());
  await send(app, event(4, "group-4"));
  expect(store.outbox.list(100, 0)).toHaveLength(2);
  expect(store.outbox.stats().dropped).toBe(1);
});

test("leases recover across restarts, reject stale completions, bound attempts and cancel edited rules", () => {
  const directory = mkdtempSync(join(tmpdir(), "tiny-sentry-outbox-"));
  directories.push(directory);
  const config = settings([rule()], { DB_PATH: join(directory, "events.sqlite") });
  let store = open(config);
  const now = Date.now();
  store.ingest("1", [prepareEvent(event(1), 1024)!], now);
  const original = store.outbox.claim(now)!;
  store.close();
  stores.delete(store);
  store = open(config);
  expect(store.outbox.claim(now + leaseMs - 1)).toBeNull();
  let clock = now + leaseMs;
  const recovered = store.outbox.claim(clock)!;
  expect(recovered.id).toBe(original.id);
  expect(recovered.attempts).toBe(2);
  store.outbox.finish(original, "delivered", clock, clock);
  expect(store.outbox.list(10, 0)[0]?.status).toBe("delivering");
  for (let attempt = 3; attempt <= maxAttempts; attempt++) {
    clock += leaseMs;
    expect(store.outbox.claim(clock)?.attempts).toBe(attempt);
  }
  clock += leaseMs;
  expect(store.outbox.claim(clock)).toBeNull();
  expect(store.outbox.list(10, 0)[0]?.status).toBe("failed");
  expect(store.outbox.retry(original.id, config.integrations, clock)).toBe(true);
  expect(store.outbox.claim(clock)?.attempts).toBe(1);
  const edited = settings([{ ...rule(), options: { url: "https://different.example" } }]);
  store.outbox.reconcile(edited.integrations, clock);
  expect(store.outbox.list(10, 0)[0]?.status).toBe("cancelled");
  expect(store.outbox.retry(original.id, edited.integrations)).toBe(false);
});

test("background webhook delivery retries 429 with stable keys, signs raw bytes, and allows manual retry after a permanent failure", async () => {
  const requests: { key: string | null; signature: string | null; body: string; auth: string | null; time: number }[] = [];
  let permanentFailure = false;
  const receiver = Bun.serve({ port: 0, async fetch(request) {
    requests.push({ key: request.headers.get("idempotency-key"), signature: request.headers.get("x-tiny-sentry-signature"),
      body: await request.text(), auth: request.headers.get("authorization"), time: Date.now() });
    return new Response(null, { status: permanentFailure ? 401 : requests.length === 1 ? 429 : 204, headers: { "Retry-After": "1" } });
  } });
  try {
    const config = settings([{ ...rule(), options: { url: `http://127.0.0.1:${receiver.port}`, tokenEnv: "HOOK_TOKEN", signingSecretEnv: "HOOK_SIGNING" } }]);
    const store = open(config);
    const worker = createDispatcher(store.outbox, await loadDeliveries(config, { HOOK_TOKEN: "credential", HOOK_SIGNING: "signing-secret" }));
    workers.push(worker);
    const app = createApp(config, store, worker.wake);
    expect((await send(app, event(1))).status).toBe(200);
    await until(() => store.outbox.list(10, 0)[0]?.status === "delivered");
    expect(requests).toHaveLength(2);
    expect(requests[1]!.time - requests[0]!.time).toBeGreaterThanOrEqual(950);
    expect(requests[0]!.key).toBe(requests[1]!.key);
    for (const request of requests) {
      const timestamp = /^t=(\d+),v1=/.exec(request.signature!)![1];
      const signature = createHmac("sha256", "signing-secret").update(`${timestamp}.${request.body}`).digest("hex");
      expect(request.signature).toBe(`t=${timestamp},v1=${signature}`);
      expect(request.auth).toBe("Bearer credential");
    }
    permanentFailure = true;
    expect((await send(app, event(2, "another"))).status).toBe(200);
    await until(() => store.outbox.list(10, 0)[0]?.status === "failed");
    const job = store.outbox.list(10, 0)[0]!;
    expect(job.attempts).toBe(1);
    permanentFailure = false;
    const response = await app.request(`/api/integrations/deliveries/${job.id}/retry`, {
      method: "POST", headers: { Authorization: `Bearer ${admin}` },
    });
    expect(response.status).toBe(200);
    await until(() => store.outbox.list(10, 0)[0]?.status === "delivered");
    expect(requests[2]!.key).toBe(requests[3]!.key);
    const output = await (await app.request("/api/integrations/deliveries", { headers: { Authorization: `Bearer ${admin}` } })).text();
    expect(output).not.toContain("credential");
    expect(output).not.toContain("signing-secret");
    expect(output).not.toContain("shared");
    await worker.stop();
  } finally { await receiver.stop(true); }
});

test("shutdown aborts a provider request and leaves its durable job retryable", async () => {
  const received = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const receiver = Bun.serve({ port: 0, async fetch() { received.resolve(); await release.promise; return new Response(); } });
  try {
    const config = settings([{ ...rule(), options: { url: `http://127.0.0.1:${receiver.port}` } }]);
    const store = open(config);
    const worker = createDispatcher(store.outbox, await loadDeliveries(config));
    workers.push(worker);
    const app = createApp(config, store, worker.wake);
    expect((await send(app, event(1))).status).toBe(200);
    await Promise.race([received.promise, Bun.sleep(2000).then(() => { throw new Error("Provider was not called"); })]);
    await worker.stop();
    expect(store.outbox.list(10, 0)[0]?.status).toBe("pending");
    expect(store.stats().events).toBe(1);
  } finally { release.resolve(); await receiver.stop(true); }
});

const notification: Notification = { kind: "new_issue", issue: {
  id: 42, project_id: "1", fingerprint: "f".repeat(64), title: "TypeError: @everyone broke", level: "error",
  status: "unresolved", first_seen: 1, last_seen: 2, event_count: 10,
} };

test.each([
  { type: "github", options: { repository: "owner/repo", tokenEnv: "TOKEN" }, secret: "github-secret", url: "https://api.github.com/repos/owner/repo/issues", auth: "Bearer github-secret", result: {},
    expected: { title: "TypeError: @everyone broke" } },
  { type: "linear", options: { teamId: "team-uuid", tokenEnv: "TOKEN" }, secret: "linear-secret", url: "https://api.linear.app/graphql", auth: "linear-secret", result: { data: { issueCreate: { success: true } } },
    expected: { variables: { input: { teamId: "team-uuid", title: "TypeError: @everyone broke" } } } },
  { type: "jira", options: { baseUrl: "https://example.atlassian.net", projectKey: "APP", issueTypeId: "10001", emailEnv: "EMAIL", tokenEnv: "TOKEN" }, secret: "jira-secret", url: "https://example.atlassian.net/rest/api/3/issue", auth: `Basic ${Buffer.from("person@example.com:jira-secret").toString("base64")}`, result: {},
    expected: { fields: { project: { key: "APP" }, issuetype: { id: "10001" }, summary: "TypeError: @everyone broke", description: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: expect.stringContaining("Occurrences: 10") }] }] } } } },
  { type: "telegram", options: { chatId: "-123", tokenEnv: "TOKEN" }, secret: "123:telegram_secret", url: "https://api.telegram.org/bot123:telegram_secret/sendMessage", auth: null, result: { ok: true },
    expected: { chat_id: "-123", text: expect.stringContaining("issue #42"), link_preview_options: { is_disabled: true } } },
  { type: "discord", options: { urlEnv: "TOKEN" }, secret: "https://discord.com/api/webhooks/123/secret", url: "https://discord.com/api/webhooks/123/secret?wait=true", auth: null, result: {},
    expected: { content: expect.stringContaining("issue #42"), allowed_mentions: { parse: [] } } },
])("$type adapter constructs the provider's issue/message request", async (fixture) => {
  const requests: Request[] = [];
  const mock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (url: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new Request(url, init));
    return Response.json(fixture.result);
  }, { preconnect: fetch.preconnect }));
  try {
    const config = settings([{ id: "provider", type: fixture.type, trigger: { type: "new_issue" }, options: fixture.options }]);
    const delivery = [...(await loadDeliveries(config, { TOKEN: fixture.secret, EMAIL: "person@example.com" })).values()][0]!;
    await delivery.send(notification, { signal: new AbortController().signal, idempotencyKey: "delivery-uuid" });
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.url).toBe(fixture.url);
    expect(request.method).toBe("POST");
    expect(request.headers.get("authorization")).toBe(fixture.auth);
    expect(await request.json()).toMatchObject(fixture.expected);
    expect(request.redirect).toBe("error");
  } finally { mock.mockRestore(); }
});

test("GraphQL and Telegram logical failures are not treated as successful HTTP deliveries", async () => {
  let result: unknown = { errors: [{ message: "bad team" }] };
  let status = 200;
  let headers: Record<string, string> = {};
  const mock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => Response.json(result, { status, headers }), { preconnect: fetch.preconnect }));
  const context = { signal: new AbortController().signal, idempotencyKey: "job" };
  try {
    const linear = builtinPlugins.linear!.create({ teamId: "team", tokenEnv: "TOKEN" }, { TOKEN: "secret" });
    await expect(linear.send(notification, context)).rejects.toMatchObject({ retryable: false });
    result = { errors: [{ extensions: { code: "RATELIMITED" } }] };
    await expect(linear.send(notification, context)).rejects.toMatchObject({ retryable: true, retryAfterMs: 60_000 });
    result = { ok: false, error_code: 403 };
    const telegram = builtinPlugins.telegram!.create({ chatId: "-123", tokenEnv: "TOKEN" }, { TOKEN: "123:secret" });
    await expect(telegram.send(notification, context)).rejects.toBeInstanceOf(DeliveryError);
    status = 429;
    result = { ok: false, error_code: 429, parameters: { retry_after: 23 } };
    await expect(telegram.send(notification, context)).rejects.toMatchObject({ retryable: true, retryAfterMs: 23_000, httpStatus: 429 });
    status = 403;
    result = {};
    headers = { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.ceil(Date.now() / 1000) + 60) };
    const github = builtinPlugins.github!.create({ repository: "owner/repo", tokenEnv: "TOKEN" }, { TOKEN: "secret" });
    await expect(github.send(notification, context)).rejects.toMatchObject({ retryable: true, httpStatus: 403 });
  } finally { mock.mockRestore(); }
});

test("an optional local TypeScript module extends delivery without changes to ingestion", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tiny-sentry-plugin-"));
  directories.push(directory);
  const module = join(directory, "plugin.ts");
  const output = join(directory, "delivery.json");
  writeFileSync(module, `export default { file: { create(options) { return {
    async send(notification, context) { await Bun.write(options.path, JSON.stringify({ notification, key: context.idempotencyKey })); }
  }; } } };`);
  const config = settings([{ id: "custom", type: "file", trigger: { type: "new_issue" }, options: { path: output } }], { INTEGRATIONS_MODULE: module });
  const store = open(config);
  const worker = createDispatcher(store.outbox, await loadDeliveries(config));
  workers.push(worker);
  const app = createApp(config, store, worker.wake);
  expect((await send(app, event(1))).status).toBe(200);
  await until(() => store.outbox.list(10, 0)[0]?.status === "delivered");
  const delivered = await Bun.file(output).json();
  expect(delivered.notification).toMatchObject({ kind: "new_issue", issue: { project_id: "1", title: "shared" } });
  expect(delivered.key).toBe(store.outbox.list(10, 0)[0]?.id);
});
