import { afterEach, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { Store } from "../src/store";

const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
const admin = "a".repeat(64), key = "b".repeat(32);

async function output() {
  const root = await mkdtemp(join(tmpdir(), "tiny-next-upload-")); directories.push(root);
  const dist = join(root, ".next");
  const browser = join(dist, "static", "chunks");
  const server = join(dist, "server");
  await mkdir(browser, { recursive: true }); await mkdir(server, { recursive: true });
  const leaf = (source: string) => ({ version: 3, sources: [source], sourcesContent: ["throw new Error();"], names: [], mappings: "AAAA" });
  await writeFile(join(browser, "hashed-map.js.map"), JSON.stringify(leaf("turbopack:///[project]/apps/web/app.js")));
  await writeFile(join(browser, "app.js"), '// unchanged browser bytes\n//# debugId=12345678-1234-1234-1234-123456789abc\n//# sourceMappingURL=hashed-map.js.map');
  await writeFile(join(browser, "vendor.js.map"), JSON.stringify(leaf("turbopack:///[project]/node_modules/vendor/index.js")));
  await writeFile(join(browser, "vendor.js"), "// vendor\n//# sourceMappingURL=vendor.js.map");
  await writeFile(join(browser, "vendor-copy.js"), "// another reference\n//# sourceMappingURL=vendor.js.map");
  await writeFile(join(browser, "style.css.map"), "{}");
  await writeFile(join(server, "page.js.map"), JSON.stringify({ version: 3, sections: [{ offset: { line: 1, column: 0 }, map: leaf("../app/page.js") }] }));
  await writeFile(join(server, "page.js"), "// unchanged server bytes");
  const copy = join(dist, "standalone", "apps", "web", ".next", "static");
  await cp(join(dist, "static"), copy, { recursive: true });
  return { dist, browser, copy };
}

async function cli(dist: string, url: string, args: string[] = [], extra: Record<string, string> = {}) {
  const child = Bun.spawn([process.env.NODE_BINARY || "node", resolve("tools/upload-sourcemaps.mjs"), "next", dist,
    "--project", "1", "--release", "web@immutable", ...args], {
    env: { PATH: process.env.PATH, TINY_SENTRY_URL: url, TINY_SENTRY_ADMIN_TOKEN: admin, ...extra }, stdout: "pipe", stderr: "pipe",
  });
  const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { out, err, exit };
}

test("standalone Node uploader preflights app maps, retries 429, and cleans every public copy without changing JS", async () => {
  const f = await output();
  const config = loadConfig({ ADMIN_TOKEN: admin, SENTRY_PROJECTS: JSON.stringify({ "1": key }), DB_PATH: ":memory:", SOURCEMAPS_ENABLED: "true" });
  const store = new Store(config), app = createApp(config, store);
  let posts = 0, retryAt = 0, retriedAt = 0;
  const server = Bun.serve({ port: 0, fetch(request) {
    if (request.method === "POST") {
      posts++;
      if (posts === 1) {
        const retryAfter = new Date(Date.now() + 3000).toUTCString(); retryAt = Date.parse(retryAfter);
        return new Response("busy", { status: 429, headers: { "Retry-After": retryAfter } });
      }
      if (posts === 2) retriedAt = Date.now();
    }
    return app.fetch(request);
  } });
  const url = `http://127.0.0.1:${server.port}`;
  try {
    const plan = await cli(f.dist, url, ["--dry-run", "--delete-public-maps"]);
    expect(plan.exit).toBe(0);
    expect(JSON.parse(plan.out)).toMatchObject({ selected: 2, indexed: 1, blocked: false, skipped: { vendor_or_empty: 1, non_javascript: 1 }, public_maps_to_delete: 6 });
    expect(posts).toBe(0);
    const before = await readFile(join(f.browser, "app.js"));
    const result = await cli(f.dist, url, ["--delete-public-maps"]);
    expect(result.err).toBe(""); expect(result.exit).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({ uploaded: 2, public_maps_deleted: 6 });
    expect(posts).toBe(3); expect(retriedAt).toBeGreaterThanOrEqual(retryAt);
    for (const root of [f.browser, join(f.copy, "chunks")]) for (const name of ["hashed-map.js.map", "vendor.js.map", "style.css.map"]) {
      expect(await Bun.file(join(root, name)).exists()).toBe(false);
    }
    expect(await readFile(join(f.browser, "app.js"))).toEqual(before);
    expect(await Bun.file(join(f.dist, "server", "page.js.map")).exists()).toBe(true);
    const maps = store.sourceMaps!.list("1", 100, 0).sourcemaps;
    expect(maps.flatMap((map) => map.releases.map((alias) => alias.url)).sort()).toEqual(["app:///_next/server/page.js", "~/_next/static/chunks/app.js"]);
    expect(maps.find((map) => map.debug_id)?.debug_id).toBe("12345678-1234-1234-1234-123456789abc");
    const mismatch = await cli(f.dist, url, [], { NEXT_PUBLIC_SENTRY_DSN: `http://${key}@127.0.0.1:${server.port}/2` });
    expect(mismatch.exit).toBe(1); expect(mismatch.err).toContain("does not match");
  } finally { await server.stop(true); store.close(); }
});

test.each([409, 507, 429])("HTTP %i hard failure or excessive Retry-After preserves public maps without retry", async (status) => {
  const f = await output();
  const config = loadConfig({ ADMIN_TOKEN: admin, SENTRY_PROJECTS: JSON.stringify({ "1": key }), DB_PATH: ":memory:", SOURCEMAPS_ENABLED: "true" });
  const store = new Store(config), app = createApp(config, store);
  let posts = 0;
  const server = Bun.serve({ port: 0, fetch(request) {
    if (request.method === "POST") { posts++; return new Response("failure", { status, headers: { "Retry-After": "3600" } }); }
    return app.fetch(request);
  } });
  try {
    const result = await cli(f.dist, `http://127.0.0.1:${server.port}`, ["--delete-public-maps"]);
    expect(result.exit).toBe(1); expect(result.err).toContain(`HTTP ${status}`); expect(posts).toBe(1);
    expect(await Bun.file(join(f.browser, "hashed-map.js.map")).exists()).toBe(true);
    expect(await Bun.file(join(f.copy, "chunks", "hashed-map.js.map")).exists()).toBe(true);
  } finally { await server.stop(true); store.close(); }
});

test("preflight blocks a full collector before uploading or deleting maps", async () => {
  const f = await output();
  const config = loadConfig({ ADMIN_TOKEN: admin, SENTRY_PROJECTS: JSON.stringify({ "1": key }), DB_PATH: ":memory:", SOURCEMAPS_ENABLED: "true", SOURCEMAPS_MAX_ARTIFACTS: "1" });
  const store = new Store(config), app = createApp(config, store);
  let posts = 0;
  const server = Bun.serve({ port: 0, fetch(request) { if (request.method === "POST") posts++; return app.fetch(request); } });
  try {
    const result = await cli(f.dist, `http://127.0.0.1:${server.port}`, ["--delete-public-maps"]);
    expect(result.exit).toBe(1); expect(result.err).toContain("SOURCEMAPS_MAX_ARTIFACTS"); expect(posts).toBe(0);
    expect(store.sourceMaps!.list("1", 100, 0).sourcemaps).toHaveLength(0);
    expect(await Bun.file(join(f.browser, "hashed-map.js.map")).exists()).toBe(true);
  } finally { await server.stop(true); store.close(); }
});

test("shared Turbopack maps upload every generated filename alias without duplicating the blob", async () => {
  const f = await output();
  const config = loadConfig({ ADMIN_TOKEN: admin, SENTRY_PROJECTS: JSON.stringify({ "1": key }), DB_PATH: ":memory:", SOURCEMAPS_ENABLED: "true" });
  const store = new Store(config), app = createApp(config, store);
  const server = Bun.serve({ port: 0, fetch: app.fetch });
  try {
    const result = await cli(f.dist, `http://127.0.0.1:${server.port}`, ["--selection", "all"]);
    expect(result.err).toBe(""); expect(result.exit).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({ selected: 4, selected_maps: 3, uploaded: 4 });
    const inventory = store.sourceMaps!.list("1", 100, 0);
    expect(inventory.storage.count).toBe(3);
    expect(inventory.sourcemaps.find((map) => map.releases.length === 2)?.releases.map((alias) => alias.url).sort())
      .toEqual(["~/_next/static/chunks/vendor-copy.js", "~/_next/static/chunks/vendor.js"]);
  } finally { await server.stop(true); store.close(); }
});
