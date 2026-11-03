import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { HTTPException } from "hono/http-exception";
import type { Config } from "../config";
import { object, type JsonObject } from "../protocol";
import { artifactUrl, debugId, parseMap, urlPath, type OriginalLocation, type SourceMap } from "./map";

interface Artifact {
  id: string;
  project_id: string;
  debug_id: string | null;
  sha256: string;
  raw_bytes: number;
  stored_bytes: number;
  uploaded_at: number;
}

export interface FrameMapping {
  path: string;
  status: "mapped" | "missing_map" | "invalid_map" | "invalid_location" | "unmapped" | "limit_exceeded";
  original: JsonObject;
  mapped?: OriginalLocation;
}

export interface Symbolication { frames: FrameMapping[]; truncated: boolean }

function locations(event: JsonObject) {
  const found: { path: string; frame: JsonObject }[] = [];
  function stack(value: unknown, path: string) {
    if (object(value) && Array.isArray(value.frames)) value.frames.forEach((frame, index) => {
      if (object(frame)) found.push({ path: `${path}.frames.${index}`, frame });
    });
  }
  stack(event.stacktrace, "stacktrace");
  for (const key of ["exception", "threads"]) {
    const container = event[key];
    if (object(container) && Array.isArray(container.values)) container.values.forEach((value, index) => {
      if (object(value)) stack(value.stacktrace, `${key}.values.${index}.stacktrace`);
    });
  }
  return found;
}

/** Compressed blobs share the existing transaction, database cap, and consistent backups. */
export class SourceMaps {
  private cache = new Map<string, { map: SourceMap; weight: number }>();
  private cacheWeight = 0;

  constructor(private db: Database, private config: NonNullable<Config["sourceMaps"]>) {}

  upload(project: string, bytes: Uint8Array, query: URLSearchParams) {
    if (bytes.byteLength > this.config.maxUploadBytes) throw new HTTPException(413, { message: "Source map too large" });
    if ([...query.keys()].some((key) => !["debug_id", "release", "dist", "url"].includes(key) || query.getAll(key).length !== 1)) {
      throw new HTTPException(400, { message: "Unknown or repeated source map metadata" });
    }
    const map = parseMap(bytes);
    if (map.weight > this.config.cacheBytes) throw new HTTPException(413, { message: "Decoded source map exceeds SOURCEMAPS_CACHE_MB" });
    const suppliedId = query.get("debug_id");
    if (suppliedId !== null && (!debugId(suppliedId) || (map.debugId && debugId(suppliedId) !== map.debugId))) {
      throw new HTTPException(400, { message: "Invalid or mismatched Debug ID" });
    }
    const id = map.debugId ?? debugId(suppliedId);
    const release = query.get("release");
    const dist = query.get("dist") ?? "";
    const url = query.has("url") ? artifactUrl(query.get("url")!) : null;
    if ((release !== null && (!release || release.length > 200)) || dist.length > 200 ||
        ((release !== null) !== (url !== null)) || (!id && !release) || (dist && !release)) {
      throw new HTTPException(400, { message: "Provide a Debug ID or both release and URL; dist requires release" });
    }
    const hash = createHash("sha256").update(bytes).digest("hex");
    const compressed = gzipSync(bytes);
    const result = this.db.transaction(() => {
      this.prune();
      const identity = this.db.query<Artifact, [string, string | null]>(`
        SELECT id,project_id,debug_id,sha256,raw_bytes,stored_bytes,uploaded_at FROM sourcemaps WHERE project_id=? AND debug_id=?
      `).get(project, id ?? null);
      if (identity && identity.sha256 !== hash) throw new HTTPException(409, { message: "Debug ID already identifies different content" });
      let artifact = identity ?? this.db.query<Artifact, [string, string, string | null]>(`
        SELECT id,project_id,debug_id,sha256,raw_bytes,stored_bytes,uploaded_at FROM sourcemaps WHERE project_id=? AND sha256=? AND debug_id IS ?
      `).get(project, hash, id ?? null);
      const alias = release && url ? this.db.query<{ artifact_id: string }, [string, string, string, string]>(`
        SELECT artifact_id FROM sourcemap_releases WHERE project_id=? AND release=? AND dist=? AND url=?
      `).get(project, release, dist, url) : null;
      if (alias && alias.artifact_id !== artifact?.id) throw new HTTPException(409, { message: "Release/dist/URL already identifies different content" });
      const now = Date.now();
      if (!artifact) {
        const { count, bytes: stored } = this.usage();
        if (count >= 1000 || stored + compressed.byteLength > this.config.maxStorageBytes) {
          throw new HTTPException(507, { message: "Source map storage limit reached; delete maps or raise the cap" });
        }
        artifact = { id: crypto.randomUUID(), project_id: project, debug_id: id ?? null,
          sha256: hash, raw_bytes: bytes.byteLength, stored_bytes: compressed.byteLength, uploaded_at: now };
        this.db.query("INSERT INTO sourcemaps VALUES (?,?,?,?,?,?,?,?)")
          .run(artifact.id, project, artifact.debug_id, hash, bytes.byteLength, compressed.byteLength, now, compressed);
      } else this.db.query("UPDATE sourcemaps SET uploaded_at=? WHERE id=?").run(now, artifact.id);
      if (release && url) {
        const count = this.db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM sourcemap_releases").get()!.count;
        if (!alias && count >= 10_000) throw new HTTPException(507, { message: "Source map release alias limit reached" });
        this.db.query(`INSERT INTO sourcemap_releases VALUES (?,?,?,?,?,?) ON CONFLICT(project_id,release,dist,url)
          DO UPDATE SET uploaded_at=excluded.uploaded_at`).run(project, release, dist, url, artifact.id, now);
      }
      return { ...artifact, uploaded_at: now };
    }).immediate();
    this.remember(result.id, map);
    return { ...result, release, dist, url };
  }

  list(project: string, limit: number, offset: number) {
    const maps = this.db.query<Artifact, [string, number, number]>(`
      SELECT id,project_id,debug_id,sha256,raw_bytes,stored_bytes,uploaded_at
      FROM sourcemaps WHERE project_id=? ORDER BY uploaded_at DESC,rowid DESC LIMIT ? OFFSET ?
    `).all(project, limit, offset);
    const aliases = this.db.query<{ release: string; dist: string; url: string; uploaded_at: number }, [string]>(
      "SELECT release,dist,url,uploaded_at FROM sourcemap_releases WHERE artifact_id=? ORDER BY uploaded_at DESC,rowid DESC LIMIT 25",
    );
    const counts = this.db.query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM sourcemap_releases WHERE artifact_id=?");
    const releaseAliases = this.db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM sourcemap_releases").get()!.count;
    return { sourcemaps: maps.map((map) => {
      const count = counts.get(map.id)!.count;
      return { ...map, releases: aliases.all(map.id), release_count: count, releases_truncated: count > 25 };
    }), storage: { ...this.usage(), max_bytes: this.config.maxStorageBytes, max_maps: 1000, release_aliases: releaseAliases, max_release_aliases: 10_000 }, limit, offset };
  }

  delete(project: string, id: string) {
    this.forget(id);
    return this.db.query("DELETE FROM sourcemaps WHERE project_id=? AND id=?").run(project, id).changes > 0;
  }

  prune(now = Date.now()) {
    this.db.query("DELETE FROM sourcemaps WHERE uploaded_at<=?").run(now - this.config.retentionDays * 86_400_000);
    this.db.query("DELETE FROM sourcemap_releases WHERE uploaded_at<=?").run(now - this.config.retentionDays * 86_400_000);
    // Bound memory even when maintenance expires a previously cached artifact.
    this.cache.clear(); this.cacheWeight = 0;
  }

  symbolicate(project: string, input: unknown): Symbolication {
    if (!object(input)) return { frames: [], truncated: false };
    const all = locations(input);
    const frames: FrameMapping[] = [];
    const loaded = new Map<string, SourceMap | null>();
    const attempted = new Set<string>();
    const overBudget = new Set<string>();
    let decodedBytes = 0;
    const images = object(input.debug_meta) && Array.isArray(input.debug_meta.images) ? input.debug_meta.images.filter(object) : [];
    for (const { path, frame } of all.slice(-100)) {
      const original: JsonObject = {};
      for (const key of ["filename", "abs_path", "function", "lineno", "colno"]) if (frame[key] !== undefined) original[key] = frame[key];
      const result: FrameMapping = { path, original, status: "missing_map" };
      frames.push(result);
      const line = frame.lineno, column = frame.colno;
      if (typeof line !== "number" || typeof column !== "number" || !Number.isSafeInteger(line) || !Number.isSafeInteger(column) || line < 1 || column < 1) {
        result.status = "invalid_location"; continue;
      }
      let url: string | undefined;
      const filename = typeof frame.abs_path === "string" ? frame.abs_path : frame.filename;
      try { if (typeof filename === "string") url = artifactUrl(filename); }
      catch { result.status = "invalid_location"; continue; }
      const ids = new Set<string>();
      let hasDebugId = frame.debug_id !== undefined;
      if (debugId(frame.debug_id)) ids.add(debugId(frame.debug_id)!);
      for (const image of images) {
        if (image.type !== "sourcemap" || typeof image.code_file !== "string" || !url) continue;
        let matches = false;
        try { matches = artifactUrl(image.code_file) === url; } catch { continue; }
        if (matches) { hasDebugId = true; if (debugId(image.debug_id)) ids.add(debugId(image.debug_id)!); }
      }
      // An advertised Debug ID is authoritative. Never silently substitute a different release map.
      if (hasDebugId && ids.size !== 1) continue;
      const row = hasDebugId
        ? this.db.query<{ id: string }, [string, string, number]>("SELECT id FROM sourcemaps WHERE project_id=? AND debug_id=? AND uploaded_at>?")
          .get(project, [...ids][0]!, this.expiry())
        : typeof input.release === "string" && url ? this.byRelease(project, input.release, typeof input.dist === "string" ? input.dist : "", url) : null;
      if (!row) continue;
      if (overBudget.has(row.id)) { result.status = "limit_exceeded"; continue; }
      if (!loaded.has(row.id)) {
        if (attempted.size >= 4) { result.status = "limit_exceeded"; continue; }
        attempted.add(row.id);
        const map = this.load(row.id);
        if (map && decodedBytes + map.weight > this.config.cacheBytes) {
          overBudget.add(row.id); result.status = "limit_exceeded"; continue;
        }
        if (map) decodedBytes += map.weight;
        loaded.set(row.id, map);
      }
      const map = loaded.get(row.id);
      if (!map) { result.status = "invalid_map"; continue; }
      const mapped = map.lookup(line, column);
      if (mapped) { result.status = "mapped"; result.mapped = mapped; }
      else result.status = "unmapped";
    }
    return { frames, truncated: all.length > 100 };
  }

  private expiry() { return Date.now() - this.config.retentionDays * 86_400_000; }

  private byRelease(project: string, release: string, dist: string, url: string) {
    const query = this.db.query<{ id: string }, [string, string, string, string, number]>(
      "SELECT artifact_id AS id FROM sourcemap_releases WHERE project_id=? AND release=? AND dist=? AND url=? AND uploaded_at>?",
    );
    return query.get(project, release, dist, url, this.expiry()) ?? (urlPath(url) ? query.get(project, release, dist, urlPath(url)!, this.expiry()) : null);
  }

  private usage() {
    return this.db.query<{ count: number; bytes: number }, []>("SELECT COUNT(*) AS count,COALESCE(SUM(stored_bytes),0) AS bytes FROM sourcemaps").get()!;
  }

  private load(id: string): SourceMap | null {
    const cached = this.cache.get(id);
    if (cached) { this.cache.delete(id); this.cache.set(id, cached); return cached.map; }
    const row = this.db.query<{ data: Uint8Array }, [string]>("SELECT data FROM sourcemaps WHERE id=?").get(id);
    if (!row) return null;
    try {
      const map = parseMap(gunzipSync(row.data, { maxOutputLength: this.config.maxUploadBytes }));
      this.remember(id, map);
      return map;
    } catch {
      console.error(JSON.stringify({ type: "sourcemap_invalid", artifact_id: id }));
      return null;
    }
  }

  private forget(id: string) {
    const entry = this.cache.get(id);
    if (entry) { this.cacheWeight -= entry.weight; this.cache.delete(id); }
  }

  private remember(id: string, map: SourceMap) {
    this.forget(id);
    if (map.weight > this.config.cacheBytes) return;
    while (this.cacheWeight + map.weight > this.config.cacheBytes) this.forget(this.cache.keys().next().value!);
    this.cache.set(id, { map, weight: map.weight }); this.cacheWeight += map.weight;
  }
}
