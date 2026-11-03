import { createHash } from "node:crypto";
import { lstat, readdir, readFile, unlink } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { debugId, parseSourceMap } from "./codec";

const hardFileLimit = 32 * 1024 * 1024;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
interface MapFile { path: string; file: string; sha256: string; raw: number; compressed: number; decoded: number; indexed: boolean; generated_file?: string; debugId?: string; url?: string }
interface Artifact { id: string; sha256: string; debug_id: string | null; releases: { release: string; dist: string; url: string }[] }
interface Inventory {
  sourcemaps: Artifact[];
  storage: { count: number; bytes: number; max_maps: number; max_bytes: number; release_aliases: number; max_release_aliases: number };
  limits?: { max_upload_bytes: number; decoded_bytes: number; retention_days: number; indexed_maps: boolean };
}

function inventoryPage(value: unknown): value is Inventory {
  if (!object(value) || !Array.isArray(value.sourcemaps) || value.sourcemaps.length > 100 || !object(value.storage)) return false;
  const storage = value.storage, limits = value.limits;
  const integers = (record: Record<string, unknown>, keys: string[], minimum: number) => keys.every((key) => {
    const number = record[key]; return typeof number === "number" && Number.isSafeInteger(number) && number >= minimum;
  });
  if (!integers(storage, ["count", "bytes", "max_maps", "max_bytes", "release_aliases", "max_release_aliases"], 0)) return false;
  if (limits !== undefined && (!object(limits) || typeof limits.indexed_maps !== "boolean" || !integers(limits, ["max_upload_bytes", "decoded_bytes", "retention_days"], 1))) return false;
  return value.sourcemaps.every((map: unknown) => object(map) && typeof map.id === "string" && typeof map.sha256 === "string" &&
    (map.debug_id === null || typeof map.debug_id === "string") && Array.isArray(map.releases) && map.releases.every((alias: unknown) =>
      object(alias) && typeof alias.release === "string" && typeof alias.dist === "string" && typeof alias.url === "string"));
}

async function bytes(path: string) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size > hardFileLimit) throw new Error(`Expected a regular file of at most 32 MiB: ${path}`);
  const result = await readFile(path);
  if (result.byteLength > hardFileLimit) throw new Error(`File changed or exceeds 32 MiB: ${path}`);
  return result;
}

async function* walk(root: string, optional = false, excluded = ["node_modules", "cache", ".git"]): AsyncGenerator<string> {
  try {
    const stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Expected a real directory: ${root}`);
  } catch (error) {
    if (optional && object(error) && error.code === "ENOENT") return;
    throw error;
  }
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (excluded.includes(entry.name)) continue;
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symlinks are not supported in build artifacts: ${path}`);
    if (entry.isDirectory()) yield* walk(path, false, excluded);
    else if (entry.isFile()) yield path;
  }
}

function applicationSources(raw: unknown, depth = 0): boolean {
  if (!object(raw) || depth > 8) throw new Error("Invalid or excessively nested source map");
  if (Array.isArray(raw.sections)) return raw.sections.some((section) => object(section) && applicationSources(section.map, depth + 1));
  return Array.isArray(raw.sources) && raw.sources.some((source) => typeof source === "string" && source.length > 0 &&
    !/(?:^|\/)node_modules\/|\[(?:turbopack|next)\]\/|webpack\/(?:bootstrap|runtime)|^<.*>$/.test(source.replaceAll("\\", "/")));
}

/** Retries only transient responses. Identity conflicts and storage exhaustion are hard failures. */
async function request(url: URL, token: string, init: RequestInit = {}): Promise<unknown> {
  const deadline = Date.now() + 120_000;
  for (let attempt = 0; attempt < 6; attempt++) {
    const response = await fetch(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(Math.max(1, Math.min(30_000, deadline - Date.now()))), redirect: "error" });
    if (response.ok) return response.json();
    const retryable = [408, 425, 429, 500, 502, 503, 504].includes(response.status);
    const header = response.headers.get("retry-after");
    const seconds = header === null ? NaN : Number(header);
    const providerDelay = header === null ? 0 : Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
    const delay = Math.max(1000 * 2 ** attempt, Number.isFinite(providerDelay) ? providerDelay : 0) + Math.floor(Math.random() * 250);
    await response.body?.cancel();
    if (!retryable || attempt === 5 || delay > 30_000 || Date.now() + delay > deadline) {
      throw new Error(`HTTP ${response.status}${retryable ? "; bounded upload retry budget exhausted" : ""}`);
    }
    await new Promise((done) => setTimeout(done, delay));
  }
  throw new Error("Upload retry budget exhausted");
}

export async function runUploader(args: string[], env: Record<string, string | undefined> = process.env) {
  if (!args.length || ["--help", "help"].includes(args[0]!)) return { usage: [
    "node upload-sourcemaps.mjs next .next --project 1 --release web@sha [--dry-run] [--delete-public-maps] [--selection app|all]",
    "node upload-sourcemaps.mjs upload dist --project 1 --release web@sha [--url-prefix '~/'] [--dist browser] [--dry-run]",
    "node upload-sourcemaps.mjs list --project 1 [--limit 25] [--offset 0]",
    "node upload-sourcemaps.mjs delete <UUID> --project 1",
  ], environment: ["TINY_SENTRY_URL", "TINY_SENTRY_ADMIN_TOKEN", "TINY_SENTRY_PROJECT", "NEXT_PUBLIC_SENTRY_RELEASE"], guide: "https://github.com/mejiasd3v/tiny-sentry/blob/main/docs/nextjs.md" };
  const action = args[0];
  const argument = args[1] && !args[1].startsWith("--") ? args[1] : undefined;
  const flags = new Set<string>();
  const options = new Map<string, string>();
  for (let index = argument ? 2 : 1; index < args.length; index++) {
    const name = args[index]!;
    if (["--dry-run", "--delete-public-maps"].includes(name)) { if (flags.has(name)) throw new Error(`Repeated option ${name}`); flags.add(name); continue; }
    if (!["--project", "--release", "--dist", "--url-prefix", "--selection", "--limit", "--offset"].includes(name) || options.has(name) || !args[index + 1] || args[index + 1]!.startsWith("--")) throw new Error("Invalid uploader option");
    options.set(name, args[++index]!);
  }
  const allowed = action === "list" ? ["--project", "--limit", "--offset"] : action === "delete" ? ["--project"]
    : action === "next" ? ["--project", "--release", "--dist", "--selection"] : ["--project", "--release", "--dist", "--url-prefix", "--selection"];
  if ([...options.keys()].some((key) => !allowed.includes(key)) || (["list", "delete"].includes(action ?? "") && flags.size)) throw new Error("Option does not apply to this command");
  const project = options.get("--project") ?? env.TINY_SENTRY_PROJECT;
  if (!project || !/^[1-9]\d{0,15}$/.test(project)) throw new Error("Set --project or TINY_SENTRY_PROJECT to this service's DSN project ID");
  const release = options.get("--release") ?? env.NEXT_PUBLIC_SENTRY_RELEASE;
  const dist = options.get("--dist") ?? "";
  if (dist.length > 200) throw new Error("dist must contain at most 200 characters");
  const base = env.TINY_SENTRY_URL ? new URL(env.TINY_SENTRY_URL) : undefined;
  if (base && (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.pathname !== "/" || base.search || base.hash)) throw new Error("TINY_SENTRY_URL must be an HTTP(S) origin without credentials");
  const token = env.TINY_SENTRY_ADMIN_TOKEN ?? env.ADMIN_TOKEN;
  const path = `/api/projects/${project}/sourcemaps`;
  async function api(suffix = "", init: RequestInit = {}) {
    if (!base || !token) throw new Error("Set TINY_SENTRY_URL and TINY_SENTRY_ADMIN_TOKEN (or ADMIN_TOKEN) in the upload job's private environment");
    return request(new URL(`${path}${suffix}`, base), token, init);
  }
  if (action === "list" && argument) throw new Error("list does not accept a positional argument");
  if (action === "list") return api(`?${new URLSearchParams([...options].filter(([key]) => ["--limit", "--offset"].includes(key)).map(([key, value]) => [key.slice(2), value]))}`);
  if (action === "delete" && argument && /^[a-f\d-]{36}$/i.test(argument)) return api(`/${argument}`, { method: "DELETE" });
  if (!["upload", "next"].includes(action ?? "") || !argument) throw new Error("Use next <.next-directory>, upload <directory>, list, or delete <UUID>; see docs/nextjs.md");
  const next = action === "next";
  if (next && !release) throw new Error("Next.js requires --release or NEXT_PUBLIC_SENTRY_RELEASE shared by browser, server, and edge");
  if (release && (release.length > 200 || (env.NEXT_PUBLIC_SENTRY_RELEASE && env.NEXT_PUBLIC_SENTRY_RELEASE !== release))) throw new Error("Release is invalid or differs from NEXT_PUBLIC_SENTRY_RELEASE");
  if (!release && (dist || options.has("--url-prefix"))) throw new Error("--dist and --url-prefix require a release");
  if (!next && flags.has("--delete-public-maps")) throw new Error("Private cleanup is available only with the next command");
  for (const name of ["SENTRY_DSN", "NEXT_PUBLIC_SENTRY_DSN"]) if (env[name]) {
    const dsn = new URL(env[name]);
    if (dsn.pathname.split("/").filter(Boolean).at(-1) !== project || (base && dsn.origin !== base.origin)) throw new Error(`${name} does not match the upload project/collector`);
  }
  const selection = options.get("--selection") ?? (next ? "app" : "all");
  if (!["app", "all"].includes(selection)) throw new Error("--selection must be app or all");
  const root = resolve(argument);
  const files: string[] = [], generatedFiles: string[] = [];
  const publicMaps = new Map<string, string>();
  for (const area of next ? [join(root, "static"), join(root, "server")] : [root]) {
    for await (const file of walk(area, false, next && area === join(root, "static") ? [] : undefined)) {
      if (/\.(?:js|mjs|cjs)$/.test(file)) {
        generatedFiles.push(file);
        if (generatedFiles.length > 50_000) throw new Error("Scan at most 50,000 generated JS files");
      }
      if (!file.endsWith(".map")) continue;
      files.push(file);
      if (files.length > 10_000) throw new Error("Scan at most 10,000 maps; split large builds");
      if (next && relative(root, file).split(/[\\/]/)[0] === "static") publicMaps.set(file, hash(await bytes(file)));
    }
  }
  async function* standaloneMaps(directory: string, optional = false): AsyncGenerator<string> {
    try {
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Expected a real directory: ${directory}`);
    } catch (error) { if (optional && object(error) && error.code === "ENOENT") return; throw error; }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (["node_modules", ".git"].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Symlinks are not supported in build artifacts: ${path}`);
      if (!entry.isDirectory()) continue;
      if (entry.name === "static" && basename(directory) === basename(root)) {
        for await (const file of walk(path, false, [])) if (file.endsWith(".map")) yield file;
      } else yield* standaloneMaps(path);
    }
  }
  if (next) for await (const file of standaloneMaps(join(root, "standalone"), true)) {
    if (publicMaps.size >= 20_000) throw new Error("Scan at most 20,000 public map copies");
    publicMaps.set(file, hash(await bytes(file)));
  }
  const selected: MapFile[] = [];
  const errors: { file?: string; message: string }[] = [];
  const generated = new Map<string, { path: string; id?: string }>();
  const references = new Map<string, { path: string; id?: string }[]>();
  const mapPaths = new Set(files);
  for (const file of generatedFiles) {
    const content = (await bytes(file)).toString("utf8");
    const ids = [...content.matchAll(/\/\/[#@]\s*debugId=([a-f\d-]+)/gi)].map((match) => debugId(match[1]));
    const unique = new Set(ids);
    if (unique.has(undefined) || unique.size > 1) throw new Error(`Conflicting generated JS Debug IDs: ${relative(root, file)}`);
    const js = { path: file, id: ids[0] }; generated.set(file, js);
    for (const match of content.matchAll(/\/\/[#@]\s*sourceMappingURL=([^\s]+)/g)) {
      const reference = new URL(match[1]!, pathToFileURL(file));
      if (reference.protocol !== "file:") continue;
      const mapPath = fileURLToPath(reference);
      if (!mapPaths.has(mapPath)) continue; // Never read remote or out-of-tree references.
      const entries = references.get(mapPath) ?? [];
      if (!entries.some((entry) => entry.path === file)) entries.push(js);
      references.set(mapPath, entries);
    }
  }
  const skipped = { non_javascript: 0, vendor_or_empty: 0 };
  for (const file of files.sort()) {
    if (next && !/\.(?:js|mjs|cjs)\.map$/.test(file)) { skipped.non_javascript++; continue; }
    try {
      const content = await bytes(file);
      const raw: unknown = JSON.parse(content.toString("utf8"));
      if (selection === "app" && !applicationSources(raw)) { skipped.vendor_or_empty++; continue; }
      const map = parseSourceMap(content);
      const targets = references.get(file) ?? [generated.get(file.slice(0, -4))];
      const compressed = gzipSync(content).length, sha256 = hash(content);
      for (const js of targets) {
        if (map.debugId && js?.id && map.debugId !== js.id) throw new Error("Generated JS and source map have conflicting Debug IDs");
        const id = map.debugId ?? js?.id;
        const name = relative(root, js?.path ?? file.slice(0, -4)).replaceAll("\\", "/");
        const url = next ? name.startsWith("static/") ? `~/_next/${name}` : `app:///_next/${name}`
          : release ? `${(options.get("--url-prefix") ?? "~/").replace(/\/$/, "")}/${name}` : undefined;
        if (!id && !release) throw new Error("Map needs a Debug ID or release/URL identity");
        selected.push({ path: file, file: relative(root, file).replaceAll("\\", "/"), generated_file: js ? name : undefined, sha256, raw: content.length, compressed, decoded: map.weight, indexed: object(raw) && raw.sections !== undefined, debugId: id, url });
      }
    } catch (error) { errors.push({ file: relative(root, file), message: error instanceof Error ? error.message : "Cannot inspect map" }); }
  }
  if (!selected.length) errors.push({ message: "No selected JavaScript maps found" });
  if (next && !files.some((file) => relative(root, file).replaceAll("\\", "/").startsWith("static/") && /\.m?js\.map$/.test(file))) {
    errors.push({ message: "Missing browser maps. Enable productionBrowserSourceMaps and restore unpruned build output after cache hits; do not cache uploader side effects." });
  }
  let inventory: Inventory | undefined;
  if (base && token) {
    const maps: Artifact[] = [];
    for (let offset = 0; ; offset += 100) {
      const page = await api(`?limit=100&offset=${offset}`);
      if (!inventoryPage(page)) throw new Error("Invalid collector source map inventory");
      maps.push(...page.sourcemaps); inventory = { ...page, sourcemaps: maps };
      if (page.sourcemaps.length < 100) break;
      if (offset >= 100_000) throw new Error("Collector inventory exceeds supported bounds");
    }
  } else if (!flags.has("--dry-run")) throw new Error("Set TINY_SENTRY_URL and TINY_SENTRY_ADMIN_TOKEN before uploading");
  const limits = inventory?.limits ?? { max_upload_bytes: 8 * 1024 * 1024, decoded_bytes: 16 * 1024 * 1024, retention_days: 30, indexed_maps: true };
  let additionalBytes = 0, additionalMaps = 0, additionalAliases = 0;
  const seen = new Set<string>();
  const debugIds = new Map<string, string>();
  const aliases = new Map<string, string>();
  for (const map of selected) {
    if (map.debugId) {
      if (debugIds.has(map.debugId) && debugIds.get(map.debugId) !== map.sha256) errors.push({ file: map.file, message: "Build contains one Debug ID with conflicting map content" });
      debugIds.set(map.debugId, map.sha256);
    }
    if (map.raw > limits.max_upload_bytes) errors.push({ file: map.file, message: "Exceeds SOURCEMAPS_MAX_UPLOAD_BYTES" });
    if (map.decoded > limits.decoded_bytes) errors.push({ file: map.file, message: "Exceeds SOURCEMAPS_CACHE_MB decoded budget" });
    if (inventory && !inventory.limits?.indexed_maps && map.indexed) errors.push({ file: map.file, message: "Upgrade collector for indexed maps before uploading" });
    const existing = inventory?.sourcemaps.find((entry) => (map.debugId && entry.debug_id === map.debugId) || (entry.sha256 === map.sha256 && entry.debug_id === (map.debugId ?? null)));
    if (existing && existing.sha256 !== map.sha256) errors.push({ file: map.file, message: "Debug ID conflict with stored content (HTTP 409)" });
    const aliasOwner = release && inventory?.sourcemaps.find((entry) => entry.releases.some((alias) => alias.release === release && alias.dist === dist && alias.url === map.url));
    if (aliasOwner && aliasOwner.id !== existing?.id) errors.push({ file: map.file, message: "Release/dist/URL conflict with stored content (HTTP 409)" });
    const identity = `${map.debugId ?? ""}:${map.sha256}`;
    if (release && map.url) {
      if (aliases.has(map.url) && aliases.get(map.url) !== identity) errors.push({ file: map.file, message: "Build contains conflicting maps for one release/dist/URL" });
      if (!aliases.has(map.url) && !existing?.releases.some((alias) => alias.release === release && alias.dist === dist && alias.url === map.url)) additionalAliases++;
      aliases.set(map.url, identity);
    }
    if (!existing && !seen.has(identity)) { additionalBytes += map.compressed; additionalMaps++; seen.add(identity); }
  }
  const storage = inventory?.storage;
  if (storage && storage.count + additionalMaps > storage.max_maps) errors.push({ message: "Projected artifacts exceed SOURCEMAPS_MAX_ARTIFACTS; shorten retention deliberately, choose app selection, or raise the cap" });
  if (storage && storage.bytes + additionalBytes > storage.max_bytes) errors.push({ message: "Projected compressed storage exceeds SOURCEMAPS_MAX_STORAGE_MB" });
  if (storage && storage.release_aliases + additionalAliases > storage.max_release_aliases) errors.push({ message: "Projected aliases exceed SOURCEMAPS_MAX_RELEASE_ALIASES" });
  const report = { mode: inventory ? "collector-preflight" : "offline-default-limits", project, release, selection, scanned: files.length, selected: selected.length, selected_maps: new Set(selected.map((map) => map.path)).size,
    skipped, indexed: selected.filter((map) => map.indexed).length, without_generated_file: selected.filter((map) => !map.generated_file).length, without_debug_id: selected.filter((map) => !map.debugId).length,
    raw_bytes: selected.reduce((sum, map) => sum + map.raw, 0), estimated_additional_maps: additionalMaps, estimated_additional_compressed_bytes: additionalBytes, estimated_additional_aliases: additionalAliases,
    storage, limits, public_maps_to_delete: flags.has("--delete-public-maps") ? publicMaps.size : 0, errors,
    files: selected.map(({ path: _path, ...map }) => map), blocked: errors.length > 0 };
  if (flags.has("--dry-run")) return report;
  if (errors.length) throw new Error(`Preflight blocked upload before any writes:\n${JSON.stringify(report, null, 2)}`);
  let uploaded = 0;
  const artifacts: unknown[] = [];
  for (const map of selected) {
    const content = await bytes(map.path);
    if (hash(content) !== map.sha256) throw new Error("Build changed after preflight; restore a stable build before uploading");
    const query = new URLSearchParams();
    if (release) { query.set("release", release); query.set("url", map.url!); if (dist) query.set("dist", dist); }
    if (map.debugId) query.set("debug_id", map.debugId);
    try { artifacts.push(await api(`?${query}`, { method: "POST", body: gzipSync(content), headers: { "Content-Type": "application/json", "Content-Encoding": "gzip" } })); uploaded++; }
    catch (error) { throw new Error(`Upload stopped at ${uploaded}/${selected.length}; earlier uploads remain stored and public maps were preserved. ${error instanceof Error ? error.message : "Upload failed"}`); }
  }
  if (flags.has("--delete-public-maps")) {
    for (const [file, digest] of publicMaps) if (hash(await bytes(file)) !== digest) throw new Error("Public map changed during upload; cleanup aborted before deleting any files");
    for (const file of publicMaps.keys()) await unlink(file);
  }
  return { ...report, uploaded, artifacts, public_maps_deleted: flags.has("--delete-public-maps") ? publicMaps.size : 0 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runUploader(process.argv.slice(2)).then((result) => {
    console.log(JSON.stringify(result, null, 2));
    if (object(result) && result.blocked) process.exitCode = 2;
  }).catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Upload failed"); process.exitCode = 1; });
}
