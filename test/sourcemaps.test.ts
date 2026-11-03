import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { createApp } from "../src/app";
import { loadConfig, type Config } from "../src/config";
import { enrichNotification } from "../src/integrations/enrich";
import { createDispatcher, loadDeliveries } from "../src/integrations/runtime";
import type { Notification } from "../src/integrations/types";
import { Store } from "../src/store";

const admin = "a".repeat(64), key = "b".repeat(32);
const debug = "12345678-1234-1234-1234-123456789abc";
const secondDebug = "87654321-4321-4321-4321-cba987654321";
const stores = new Set<Store>();
const directories: string[] = [];
afterEach(() => {
  for (const store of stores) store.close();
  stores.clear();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function directory() {
  const path = mkdtempSync(join(tmpdir(), "tiny-sentry-maps-"));
  directories.push(path);
  return path;
}

function fixture(overrides: Partial<Config> = {}, env: Record<string, string> = {}) {
  const config = { ...loadConfig({ ADMIN_TOKEN: admin, SENTRY_PROJECTS: JSON.stringify({ "1": key, "2": key }),
    DB_PATH: ":memory:", SOURCEMAPS_ENABLED: "true", ...env }), ...overrides };
  const store = new Store(config);
  stores.add(store);
  const app = createApp(config, store);
  return { config, store, app,
    api: (path: string, init: RequestInit = {}) => app.request(`/api${path}`, {
      ...init, headers: { Authorization: `Bearer ${admin}`, ...init.headers },
    }),
    upload: (map: unknown = sourceMap(), query = "", project = "1") => app.request(`/api/projects/${project}/sourcemaps${query}`, {
      method: "POST", headers: { Authorization: `Bearer ${admin}` }, body: JSON.stringify(map),
    }),
    send: (input: unknown = event(), project = "1") => app.request(`/api/${project}/store/?sentry_key=${key}`, { method: "POST", body: JSON.stringify(input) }),
  };
}

function sourceMap() {
  return { version: 3, sources: ["checkout.ts"], sourceRoot: "webpack:///src/", names: ["submitOrder", "chargeCard"],
    sourcesContent: ["const cart = loadCart();\nthrow new Error('source-context-only');\nfinish();"], mappings: "AAAAA,KAAKC,K;AACLD", debug_id: debug };
}

function event(id = "1".repeat(32)) {
  return { event_id: id, platform: "javascript", release: "web@abc", dist: "browser",
    debug_meta: { images: [{ type: "sourcemap", code_file: "https://cdn.example/assets/app.js", debug_id: debug }] },
    exception: { values: [{ type: "Error", value: "Checkout failed", stacktrace: { frames: [
      { filename: "https://cdn.example/assets/app.js?cache=1", function: "a", lineno: 2, colno: 1, in_app: true },
    ] } }] } };
}

async function details(f: ReturnType<typeof fixture>, id = "1".repeat(32), project = "1") {
  const response = await f.api(`/projects/${project}/events/${id}`);
  expect(response.status).toBe(200);
  return response.json();
}

test("private uploads are optional, admin-only, and validate formats and bounded decompression", async () => {
  const off = fixture({}, { SOURCEMAPS_ENABLED: "false" });
  expect(loadConfig({ ADMIN_TOKEN: admin, SENTRY_PROJECTS: JSON.stringify({ "1": key }) }).sourceMaps).toBeUndefined();
  expect((await off.upload()).status).toBe(404);
  await off.send();
  expect((await details(off)).symbolication).toBeUndefined();
  const f = fixture();
  for (const method of ["GET", "POST", "DELETE"]) {
    const response = await f.app.request(`/api/projects/1/sourcemaps${method === "DELETE" ? "/anything" : ""}`, {
      method, headers: { Authorization: `Bearer ${key}`, Origin: "https://app.example" },
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  }
  expect((await f.upload(sourceMap(), "", "99")).status).toBe(404);
  for (const invalid of [
    { ...sourceMap(), version: 2 }, { version: 3, sections: [] }, { ...sourceMap(), sources: [123] },
    { ...sourceMap(), sourcesContent: [12] }, { ...sourceMap(), mappings: "AA" }, { ...sourceMap(), mappings: "AACA," },
    { ...sourceMap(), mappings: "ACAA" }, { ...sourceMap(), mappings: "AAAAE" }, { ...sourceMap(), mappings: "AAAA,-" },
    { ...sourceMap(), mappings: "AAAA,DAAA" }, { ...sourceMap(), mappings: "A".repeat(20) },
    { ...sourceMap(), debug_id: "wrong" }, { ...sourceMap(), debugId: secondDebug },
  ]) expect((await f.upload(invalid)).status).toBe(400);
  for (const query of ["?debug_id=bad", `?debug_id=${secondDebug}`, "?release=x", "?dist=browser", "?unknown=1", "?url=https://user:pass@cdn.example/app.js&release=x", "?release=x&release=y&url=app.js"]) {
    expect((await f.upload(sourceMap(), query)).status).toBe(400);
  }
  const small = fixture({}, { SOURCEMAPS_MAX_UPLOAD_BYTES: "512" });
  expect((await small.api("/projects/1/sourcemaps", { method: "POST", headers: { "Content-Encoding": "gzip" },
    body: Bun.gzipSync(JSON.stringify({ ...sourceMap(), sourcesContent: ["x".repeat(3000)] })) })).status).toBe(413);
  expect((await small.api("/projects/1/sourcemaps", { method: "POST", headers: { "Content-Encoding": "gzip" }, body: "broken" })).status).toBe(400);
  const decodedCap = fixture({}, { SOURCEMAPS_CACHE_MB: "1" });
  expect((await decodedCap.upload({ ...sourceMap(), sourcesContent: ["x".repeat(600_000)] })).status).toBe(413);
  expect((await f.upload()).status).toBe(201);
  const listed = await (await f.api("/projects/1/sourcemaps")).json();
  expect(listed.sourcemaps).toHaveLength(1);
  expect(JSON.stringify(listed)).not.toContain("source-context-only");
  expect(JSON.stringify(listed)).not.toContain("sourcesContent");
});

test("Debug IDs map exception, message and thread stacks without mutating events or regrouping", async () => {
  const f = fixture();
  await f.send();
  const before = await details(f);
  expect(before.symbolication.frames[0].status).toBe("missing_map");
  expect((await f.upload()).status).toBe(201);
  const after = await details(f);
  expect(after.event).toEqual(before.event);
  expect(after.issue_id).toBe(before.issue_id);
  expect(after.symbolication.frames[0]).toMatchObject({ path: "exception.values.0.stacktrace.frames.0", status: "mapped",
    original: { function: "a", lineno: 2, colno: 1 },
    mapped: { filename: "webpack:///src/checkout.ts", function: "submitOrder", lineno: 2, colno: 1,
      context_line: "throw new Error('source-context-only');", pre_context: ["const cart = loadCart();"], post_context: ["finish();"] } });
  const input = { ...event("2".repeat(32)), stacktrace: { frames: [
    { filename: "https://cdn.example/assets/app.js", lineno: 1, colno: 8 },
    { filename: "https://cdn.example/assets/app.js", lineno: 1, colno: 11 },
    { filename: "https://cdn.example/assets/app.js", lineno: 3, colno: 1 },
    { filename: "https://cdn.example/assets/app.js", lineno: 1, colno: 0 },
  ] }, threads: { values: [{ stacktrace: { frames: [{ filename: "https://cdn.example/assets/app.js", lineno: 1, colno: 1 }] } }] } };
  await f.send(input);
  const mapped = (await details(f, input.event_id)).symbolication.frames;
  expect(mapped.map((frame: { status: string }) => frame.status)).toEqual(["mapped", "unmapped", "unmapped", "invalid_location", "mapped", "mapped"]);
  expect(mapped[0].mapped).toMatchObject({ function: "chargeCard", lineno: 1, colno: 6 });
  expect((await (await f.api("/issues/1")).json()).latest_event.symbolication.frames).toEqual(mapped);
  expect(f.store.stats()).toEqual({ events: 2, issues: 1 });
});

test("concurrent uploads reject excess work before buffering another request", async () => {
  const f = fixture();
  const reading = Promise.withResolvers<void>();
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, pull() { reading.resolve(); } }, { highWaterMark: 0 });
  const first = f.api("/projects/1/sourcemaps", { method: "POST", body: stream });
  await reading.promise;
  const excess = await f.upload();
  expect(excess.status).toBe(429);
  expect(excess.headers.get("retry-after")).toBe("1");
  controller!.enqueue(Buffer.from(JSON.stringify(sourceMap()))); controller!.close();
  expect((await first).status).toBe(201);
  expect((await f.upload()).status).toBe(201);
});

test("matching isolates projects, release, dist and full paths and never overrides an advertised Debug ID", async () => {
  const f = fixture();
  const { debug_id, ...fallback } = sourceMap();
  const query = `?${new URLSearchParams({ release: "web@abc", dist: "browser", url: "~/assets/app.js" })}`;
  expect((await f.upload(fallback, query)).status).toBe(201);
  await f.send();
  expect((await details(f)).symbolication.frames[0].status).toBe("missing_map");
  const noDebug = { ...event("2".repeat(32)), debug_meta: undefined };
  await f.send(noDebug);
  expect((await details(f, noDebug.event_id)).symbolication.frames[0].status).toBe("mapped");
  const variants = [
    { ...noDebug, release: "web@other" }, { ...noDebug, dist: undefined },
    { ...noDebug, exception: { values: [{ stacktrace: { frames: [{ filename: "https://cdn.example/other/app.js", lineno: 2, colno: 1 }] } }] } },
  ];
  for (let index = 0; index < variants.length; index++) {
    const input = { ...variants[index], event_id: (index + 3).toString().repeat(32) };
    await f.send(input);
    expect((await details(f, input.event_id)).symbolication.frames[0].status).toBe("missing_map");
  }
  await f.send(noDebug, "2");
  expect((await details(f, noDebug.event_id, "2")).symbolication.frames[0].status).toBe("missing_map");
  expect((await f.upload()).status).toBe(201);
  expect((await details(f)).symbolication.frames[0].status).toBe("mapped");
  const ambiguous = { ...event("6".repeat(32)), debug_meta: { images: [
    ...event().debug_meta.images, { type: "sourcemap", code_file: "https://cdn.example/assets/app.js", debug_id: secondDebug },
  ] } };
  await f.send(ambiguous);
  expect((await details(f, ambiguous.event_id)).symbolication.frames[0].status).toBe("missing_map");
});

test("unchanged chunks can share one Debug ID map across releases without storing duplicate blobs", async () => {
  const path = join(directory(), "events.sqlite");
  const f = fixture({ dbPath: path });
  const query = (release: string) => `?${new URLSearchParams({ release, dist: "browser", url: "~/assets/app.js" })}`;
  expect((await f.upload(sourceMap(), query("web@first"))).status).toBe(201);
  expect((await f.upload(sourceMap(), query("web@abc"))).status).toBe(201);
  const listed = await (await f.api("/projects/1/sourcemaps")).json();
  expect(listed.sourcemaps).toHaveLength(1);
  expect(listed.sourcemaps[0].releases).toHaveLength(2);
  expect(listed.storage.bytes).toBe(listed.sourcemaps[0].stored_bytes);
  await f.send({ ...event(), debug_meta: undefined });
  expect((await details(f)).symbolication.frames[0].status).toBe("mapped");
  expect((await f.upload({ ...sourceMap(), sources: ["wrong.ts"] }, query("web@abc"))).status).toBe(409);
  expect((await f.upload({ ...sourceMap(), debug_id: secondDebug }, query("web@abc"))).status).toBe(409);
  const writer = new Database(path);
  writer.query("UPDATE sourcemap_releases SET uploaded_at=? WHERE release=?").run(Date.now() - 31 * 86_400_000, "web@first");
  writer.close();
  f.store.prune();
  const remaining = await (await f.api("/projects/1/sourcemaps")).json();
  expect(remaining.sourcemaps[0].releases.map((alias: { release: string }) => alias.release)).toEqual(["web@abc"]);
  expect((await details(f)).symbolication.frames[0].status).toBe("mapped");
  expect((await f.api(`/projects/1/sourcemaps/${listed.sourcemaps[0].id}`, { method: "DELETE" })).status).toBe(200);
  expect((await (await f.api("/projects/1/sourcemaps")).json()).storage.release_aliases).toBe(0);
});

test("uploads are immutable and atomic, persist in backups, and expire independently of event retention", async () => {
  const path = directory();
  const f = fixture({ dbPath: join(path, "events.sqlite") });
  await f.send();
  const uploaded = (await (await f.upload()).json()).sourcemap;
  expect((await (await f.upload()).json()).sourcemap.id).toBe(uploaded.id);
  expect((await f.upload({ ...sourceMap(), sources: ["wrong.ts"] })).status).toBe(409);
  expect((await details(f)).symbolication.frames[0].mapped.filename).toBe("webpack:///src/checkout.ts");
  expect((await f.api(`/projects/2/sourcemaps/${uploaded.id}`, { method: "DELETE" })).status).toBe(404);
  f.store.backup(join(path, "backup.sqlite"));
  const restored = fixture({ dbPath: join(path, "backup.sqlite") });
  expect((await details(restored)).symbolication.frames[0].status).toBe("mapped");
  f.store.prune(Date.now() + 15 * 86_400_000);
  expect(f.store.stats().events).toBe(0);
  expect((await (await f.api("/projects/1/sourcemaps")).json()).sourcemaps).toHaveLength(1);
  restored.store.sourceMaps!.prune(Date.now() + 31 * 86_400_000);
  expect((await details(restored)).symbolication.frames[0].status).toBe("missing_map");
  expect((await f.api(`/projects/1/sourcemaps/${uploaded.id}`, { method: "DELETE" })).status).toBe(200);
  const capacity = fixture({}, { SOURCEMAPS_MAX_STORAGE_MB: "1" });
  const large = { ...sourceMap(), sourcesContent: [randomBytes(900_000).toString("base64")] };
  expect((await capacity.upload(large)).status).toBe(201);
  expect((await capacity.upload({ ...large, debug_id: secondDebug })).status).toBe(507);
  expect((await (await capacity.api("/projects/1/sourcemaps")).json()).sourcemaps).toHaveLength(1);
  const full = fixture({ maxDbMb: 1 });
  await full.send();
  expect((await full.upload(large)).status).toBe(201);
  expect((await full.upload({ ...large, debug_id: secondDebug })).status).toBe(507);
  expect(full.store.stats()).toEqual({ events: 1, issues: 1 });
  expect((await details(full)).symbolication.frames[0].status).toBe("mapped");
});

test("schema v3 upgrades preserve errors and pending integration deliveries before accepting maps", async () => {
  const path = join(directory(), "events.sqlite");
  const rules = [{ id: "queued", type: "webhook", trigger: { type: "new_issue" }, options: { url: "https://receiver.example/errors" } }];
  const previous = fixture({ dbPath: path, sourceMaps: undefined }, { INTEGRATIONS: JSON.stringify(rules) });
  await previous.send();
  const pending = previous.store.outbox.list(10, 0);
  previous.store.close(); stores.delete(previous.store);
  const legacy = new Database(path);
  legacy.exec("DROP TABLE IF EXISTS sourcemap_releases; DROP TABLE sourcemaps; PRAGMA user_version=3;");
  legacy.close();
  const upgraded = fixture({ dbPath: path }, { INTEGRATIONS: JSON.stringify(rules) });
  expect(upgraded.store.stats()).toEqual({ events: 1, issues: 1 });
  expect(upgraded.store.outbox.list(10, 0)).toEqual(pending);
  expect((await upgraded.upload()).status).toBe(201);
  expect((await details(upgraded)).symbolication.frames[0].status).toBe("mapped");
});

test("corrupt stored maps degrade to an explicit status, and per-event work is bounded", async () => {
  const path = join(directory(), "events.sqlite");
  const f = fixture({ dbPath: path });
  await f.upload();
  const writer = new Database(path);
  writer.query("UPDATE sourcemaps SET data=?").run(Buffer.from("broken"));
  writer.close();
  // A fresh instance must read the actual persisted blob instead of the upload cache.
  const reopened = fixture({ dbPath: path });
  await reopened.send();
  expect((await details(reopened)).symbolication.frames[0].status).toBe("invalid_map");
  const frames = Array.from({ length: 110 }, () => ({ filename: "app.js", lineno: 1, colno: 1, debug_id: debug }));
  for (let index = 0; index < 5; index++) {
    const id = `12345678-1234-1234-1234-${index.toString().padStart(12, "0")}`;
    expect((await f.upload({ ...sourceMap(), debug_id: id })).status).toBe(201);
    frames[frames.length - 5 + index]!.debug_id = id;
  }
  const input = { ...event("2".repeat(32)), debug_meta: undefined, exception: { values: [{ stacktrace: { frames } }] } };
  await f.send(input);
  const result = (await details(f, input.event_id)).symbolication;
  expect(result.truncated).toBe(true);
  expect(result.frames).toHaveLength(100);
  expect(result.frames.at(-1).status).toBe("limit_exceeded");
});

test("a real minified Bun bundle maps a runtime error through the network CLI upload flow", async () => {
  const path = directory();
  const entry = join(path, "checkout.ts");
  writeFileSync(entry, [
    "function submitOrder() {", "  const cart = { items: [] };", "  if (!cart.items.length) {",
    '    throw new Error("real-bundle-error");', "  }", "}", "submitOrder();", "",
  ].join("\n"));
  const build = await Bun.build({ entrypoints: [entry], outdir: join(path, "dist"), target: "browser", format: "iife", minify: true, sourcemap: "external" });
  expect(build.success).toBe(true);
  const javascript = build.outputs.find((file) => file.path.endsWith(".js"))!;
  const mapFile = build.outputs.find((file) => file.path.endsWith(".map"))!;
  const map = JSON.parse(readFileSync(mapFile.path, "utf8"));
  const buildId = String(map.debugId).toLowerCase().replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
  const url = "https://cdn.example/assets/checkout.js";
  let stack = "";
  try { runInNewContext(await javascript.text(), {}, { filename: url }); }
  catch (error) { stack = String((error as Error).stack); }
  const match = /https:\/\/cdn\.example\/assets\/checkout\.js:(\d+):(\d+)/.exec(stack);
  expect(match).not.toBeNull();
  expect(Number(match![1])).toBe(1);
  const f = fixture();
  const server = Bun.serve({ port: 0, fetch: f.app.fetch, maxRequestBodySize: f.config.sourceMaps!.maxUploadBytes });
  async function cli(...args: string[]) {
    const child = Bun.spawn([process.execPath, "src/cli.ts", "sourcemaps", ...args], {
      env: { ...process.env, ADMIN_TOKEN: admin, TINY_SENTRY_URL: `http://127.0.0.1:${server.port}` }, stdout: "pipe", stderr: "pipe",
    });
    const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(err).toBe(""); expect(exit).toBe(0);
    return JSON.parse(out);
  }
  try {
    const input = event();
    input.debug_meta.images[0]!.code_file = url;
    input.debug_meta.images[0]!.debug_id = buildId;
    input.exception.values[0]!.stacktrace.frames[0] = { filename: url, function: "a", lineno: Number(match![1]), colno: Number(match![2]), in_app: true };
    await f.send(input);
    expect((await details(f)).symbolication.frames[0].status).toBe("missing_map");
    const uploaded = await cli("upload", join(path, "dist"), "--project", "1");
    expect(uploaded.uploaded).toBe(1);
    const mapped = (await details(f)).symbolication.frames[0];
    expect(mapped.status).toBe("mapped");
    expect(mapped.mapped.filename).toEndWith("checkout.ts");
    expect(mapped.mapped.lineno).toBe(4);
    expect(mapped.mapped.context_line).toBe('    throw new Error("real-bundle-error");');
    const listed = await cli("list", "--project", "1");
    expect(listed.sourcemaps).toHaveLength(1);
    expect(await cli("delete", listed.sourcemaps[0].id, "--project", "1")).toEqual({ deleted: true });
    expect((await details(f)).symbolication.frames[0].status).toBe("missing_map");
    // The same real build also works without runtime Debug ID injection, using release/dist/URL.
    expect((await cli("upload", join(path, "dist"), "--project", "1", "--release", "web@abc", "--dist", "browser", "--url-prefix", "https://cdn.example/assets/")).uploaded).toBe(1);
    await f.send({ ...input, event_id: "3".repeat(32), debug_meta: undefined });
    expect((await details(f, "3".repeat(32))).symbolication.frames[0].mapped.lineno).toBe(4);
  } finally { await server.stop(true); }
});

test("integration excerpts use only the triggering event, require opt-in, and omit source code", async () => {
  const received: Notification[] = [];
  const done = Promise.withResolvers<void>();
  const receiver = Bun.serve({ port: 0, async fetch(request) {
    received.push(await request.json() as Notification);
    if (received.length === 2) done.resolve();
    return new Response("ok");
  } });
  const rules = [true, false].map((includeStacktrace) => ({ id: String(includeStacktrace), type: "webhook", includeStacktrace,
    trigger: { type: "new_issue" }, options: { url: `http://127.0.0.1:${receiver.port}` } }));
  const f = fixture({}, { INTEGRATIONS: JSON.stringify(rules) });
  const worker = createDispatcher(f.store.outbox, await loadDeliveries(f.config), (notification) => enrichNotification(f.store, notification));
  try {
    await f.upload();
    await f.send();
    // Enqueue a newer occurrence before delivery. It must not replace the trigger's stack.
    const newer = event("2".repeat(32));
    newer.exception.values[0]!.stacktrace.frames[0]!.lineno = 1;
    await f.send(newer);
    worker.wake();
    await Promise.race([done.promise, Bun.sleep(3000).then(() => { throw new Error("Integration not received"); })]);
    const deadline = Date.now() + 3000;
    while (f.store.outbox.list(10, 0).some((job) => job.status !== "delivered")) {
      if (Date.now() > deadline) throw new Error("Integration delivery did not finish");
      await Bun.sleep(5);
    }
    expect(received[0]!.stacktrace).toContain("checkout.ts:2:1");
    expect(received[0]!.event_id).toBe(event().event_id);
    expect(JSON.stringify(received)).not.toContain("source-context-only");
    expect(received[1]!.stacktrace).toBeUndefined();
    expect(received[1]!.event_id).toBeUndefined();
    f.store.prune(Date.now() + 15 * 86_400_000);
    expect(enrichNotification(f.store, { kind: "new_issue", issue: received[0]!.issue, event_id: event().event_id }).stacktrace).toBeUndefined();
  } finally { await worker.stop(); await receiver.stop(true); }
});
