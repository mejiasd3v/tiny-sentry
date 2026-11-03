import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { Store } from "../src/store";

const fixture = resolve("test/fixtures/nextjs");
const require = createRequire(join(fixture, "package.json"));
interface Browser {
  close(): Promise<void>;
  newPage(): Promise<{
    goto(url: string): Promise<unknown>;
    locator(selector: string): { click(): Promise<void>; getAttribute(name: string): Promise<string | null> };
    waitForFunction(callback: () => unknown): Promise<void>;
  }>;
}
const { chromium } = require("playwright") as { chromium: { launch(options: Record<string, unknown>): Promise<Browser> } };
const node = process.env.NEXTJS_NODE_BINARY || "node";
const admin = "a".repeat(64), key = "b".repeat(32), release = "tiny-sentry-nextjs-proof";
const temporary = await mkdtemp(join(tmpdir(), "tiny-sentry-nextjs-"));
const store = new Store(loadConfig({ ADMIN_TOKEN: admin, SENTRY_PROJECTS: JSON.stringify({ "1": key }),
  DB_PATH: join(temporary, "events.sqlite"), SOURCEMAPS_ENABLED: "true", SOURCEMAPS_CACHE_MB: "32", MAX_DB_MB: "256", RATE_LIMIT_PER_MINUTE: "10000" }));
const collector = Bun.serve({ port: 0, fetch: createApp(loadConfig({ ADMIN_TOKEN: admin, SENTRY_PROJECTS: JSON.stringify({ "1": key }),
  SOURCEMAPS_ENABLED: "true", RATE_LIMIT_PER_MINUTE: "10000" }), store).fetch, maxRequestBodySize: 8 * 1024 * 1024 });
const url = `http://127.0.0.1:${collector.port}`;
const env = { ...process.env, NEXT_TELEMETRY_DISABLED: "1", NEXT_PUBLIC_SENTRY_RELEASE: release,
  NEXT_PUBLIC_SENTRY_DSN: `http://${key}@127.0.0.1:${collector.port}/1`, TINY_SENTRY_URL: url, TINY_SENTRY_ADMIN_TOKEN: admin };
let next: ReturnType<typeof Bun.spawn> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

async function command(args: string[]) {
  const child = Bun.spawn(args, { cwd: fixture, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (exit !== 0) throw new Error(`Command failed (${args[1]}): ${stdout}\n${stderr}`);
  return stdout;
}

async function* files(directory: string): AsyncGenerator<string> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* files(path); else yield path;
  }
}

try {
  assert.match(await command([node, "--version"]), /^v22\./, "Verify the supported Node 22 build/uploader path");
  console.log("Building isolated Next.js 16.3.0 / @sentry/nextjs 11.10.0 fixture...");
  await command([node, require.resolve("next/dist/bin/next"), "build"]);
  const dist = join(fixture, ".next");
  // Next does not copy static assets into standalone by itself. Exercise a monorepo-shaped copy too.
  const copy = join(dist, "standalone", "apps", "proof", ".next", "static");
  await cp(join(dist, "static"), copy, { recursive: true });
  const generated = new Map<string, string>();
  for await (const file of files(dist)) if (file.endsWith(".js")) generated.set(file, createHash("sha256").update(await readFile(file)).digest("hex"));
  const plan = JSON.parse(await command([node, resolve("tools/upload-sourcemaps.mjs"), "next", dist, "--project", "1", "--dry-run", "--delete-public-maps"]));
  assert.equal(plan.blocked, false, JSON.stringify(plan.errors));
  const upload = JSON.parse(await command([node, resolve("tools/upload-sourcemaps.mjs"), "next", dist, "--project", "1", "--delete-public-maps"]));
  assert.equal(upload.uploaded, plan.selected);
  assert(upload.public_maps_deleted > 0);
  for await (const file of files(join(dist, "static"))) assert(!file.endsWith(".map"), "No public maps may remain");
  for await (const file of files(copy)) assert(!file.endsWith(".map"), "No standalone public map copies may remain");
  for (const [file, digest] of generated) assert.equal(createHash("sha256").update(await readFile(file)).digest("hex"), digest, "Uploader must never change generated JS");
  const portServer = Bun.serve({ port: 0, fetch: () => new Response("unused") });
  const port = portServer.port; await portServer.stop(true);
  next = Bun.spawn([node, require.resolve("next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: fixture, env, stdout: "pipe", stderr: "pipe" });
  const nextUrl = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let index = 0; index < 100; index++) {
    try { ready = (await fetch(nextUrl, { signal: AbortSignal.timeout(1000) })).ok; } catch { /* Listener startup. */ }
    if (ready) break;
    await Bun.sleep(100);
  }
  assert(ready, "Next did not start");
  const server = await (await fetch(`${nextUrl}/api/server`)).json() as { id: string };
  const edge = await (await fetch(`${nextUrl}/api/edge`)).json() as { id: string };
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
  const page = await browser.newPage();
  await page.goto(nextUrl);
  await page.locator("#capture").click();
  await page.waitForFunction(() => document.querySelector("#capture")?.getAttribute("data-event"));
  const client = await page.locator("#capture").getAttribute("data-event");
  for (const [runtime, id] of [["browser", client], ["server", server.id], ["edge", edge.id]]) {
    assert(id, `${runtime} SDK must return an event ID`);
    const response = await fetch(`${url}/api/projects/1/events/${id}`, { headers: { Authorization: `Bearer ${admin}` } });
    assert.equal(response.status, 200, `${runtime} SDK event must reach tiny-sentry`);
    const detail = await response.json() as { event: { release: string; debug_meta?: { images?: { debug_id: string; code_file: string }[] } }; symbolication: { frames: { status: string; original: { filename?: string }; mapped?: { filename: string; context_line?: string } }[] } };
    assert.equal(detail.event.release, release);
    const mapped = detail.symbolication.frames.filter((frame) => frame.status === "mapped" && frame.mapped?.context_line?.includes(`nextjs-${runtime}-proof`));
    assert(mapped.length > 0, `${runtime}: ${JSON.stringify(detail)}`);
    if (runtime !== "edge") assert(detail.event.debug_meta?.images?.length, `${runtime} SDK must report native Debug IDs`);
    else assert(!detail.event.debug_meta?.images?.length, "This edge fixture verifies release/URL fallback without native IDs");
    const fallback = store.sourceMaps!.symbolicate("1", { ...detail.event, debug_meta: undefined });
    assert(fallback.frames.some((frame) => frame.status === "mapped" && frame.mapped?.context_line?.includes(`nextjs-${runtime}-proof`)), `${runtime} must also match its release and URL: ${JSON.stringify(fallback)}`);
    if (runtime === "server") assert(mapped.some((frame) => frame.original.filename?.startsWith("app:///_next/server/")), "SDK server rewrite must match the official upload URL");
    console.log(JSON.stringify({ runtime, release: detail.event.release, debug_images: detail.event.debug_meta?.images?.length ?? 0,
      mapped_source: mapped[0]!.mapped!.filename, generated_file: mapped[0]!.original.filename }));
  }
  console.log("PASS: real Next.js browser/server/edge SDK events, browser/server native Debug IDs, edge release fallback, Node uploader, and private cleanup without JS changes");
} finally {
  await browser?.close(); next?.kill(); await next?.exited;
  await collector.stop(true); store.close(); await rm(temporary, { recursive: true, force: true });
}
