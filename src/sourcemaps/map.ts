import { HTTPException } from "hono/http-exception";
import { object, type JsonObject } from "../protocol";

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const maxSegments = 500_000;
const maxLines = 250_000;

export function debugId(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^(?:[a-f\d]{32}|[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})$/i.test(value)) return undefined;
  const compact = value.replaceAll("-", "").toLowerCase();
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

/** Logical artifact names only. These names never become filesystem paths. */
export function artifactUrl(value: string): string {
  const clean = value.split(/[?#]/, 1)[0]!;
  if (!clean || clean.length > 2048 || /[\x00-\x20\x7f]/.test(clean)) throw new HTTPException(400, { message: "Invalid artifact URL" });
  try {
    const url = new URL(clean);
    if (url.username || url.password) throw new HTTPException(400, { message: "Artifact URLs cannot contain credentials" });
    return url.href;
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    return clean;
  }
}

export function urlPath(value: string): string | undefined {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? `~${url.pathname}` : undefined;
  } catch { return undefined; }
}

function invalid(): never { throw new HTTPException(400, { message: "Invalid or unsupported source map v3" }); }

function strings(value: unknown, max: number): string[] {
  if (!Array.isArray(value) || value.length > max || value.some((item) => typeof item !== "string")) invalid();
  return value;
}

export interface OriginalLocation {
  filename: string;
  lineno: number;
  colno: number;
  function?: string;
  context_line?: string;
  pre_context?: string[];
  post_context?: string[];
}

/** Compact decoded segments: generated line/column, source, original line/column, name. */
export class SourceMap {
  readonly debugId: string | undefined;
  readonly weight: number;
  private segments: Int32Array;
  private sources: string[];
  private names: string[];
  private contents: (string | null)[];
  private root: string;

  constructor(raw: JsonObject) {
    if (raw.version !== 3 || raw.sections !== undefined || typeof raw.mappings !== "string") invalid();
    this.sources = strings(raw.sources, 50_000);
    this.names = strings(raw.names ?? [], 100_000);
    if (raw.sourceRoot !== undefined && typeof raw.sourceRoot !== "string") invalid();
    this.root = typeof raw.sourceRoot === "string" ? raw.sourceRoot : "";
    const content = raw.sourcesContent;
    if (content !== undefined && (!Array.isArray(content) || content.length !== this.sources.length || content.some((item) => item !== null && typeof item !== "string"))) invalid();
    this.contents = content === undefined ? [] : content as (string | null)[];
    const id = raw.debug_id ?? raw.debugId;
    if (id !== undefined && !debugId(id)) invalid();
    if (raw.debug_id !== undefined && raw.debugId !== undefined && debugId(raw.debug_id) !== debugId(raw.debugId)) invalid();
    this.debugId = debugId(id);
    const mappings = raw.mappings;
    let count = 0;
    for (let index = 0; index < mappings.length; index++) {
      if (mappings[index] !== "," && mappings[index] !== ";" && (index === 0 || mappings[index - 1] === "," || mappings[index - 1] === ";")) {
        if (++count > maxSegments) invalid();
      }
    }
    const buffer = new Int32Array(count * 6);
    let used = 0;
    let position = 0, line = 0, column = 0, source = 0, originalLine = 0, originalColumn = 0, name = 0;
    function vlq(): number {
      let value = 0, factor = 1, digit: number;
      do {
        digit = alphabet.indexOf(mappings[position++] ?? "!");
        if (digit < 0 || factor > 2 ** 35) invalid();
        value += (digit % 32) * factor;
        factor *= 32;
      } while (digit >= 32);
      const result = Math.floor(value / 2) * (value % 2 ? -1 : 1);
      if (Math.abs(result) > 2_147_483_647) invalid();
      return result;
    }
    while (position < mappings.length) {
      if (mappings[position] === ";") {
        position++; column = 0;
        if (++line >= maxLines) invalid();
        continue;
      }
      if (mappings[position] === ",") invalid();
      const delta = vlq();
      if (delta < 0 || (column += delta) > 2_147_483_647) invalid();
      let mappedSource = -1, mappedName = -1;
      if (position < mappings.length && mappings[position] !== "," && mappings[position] !== ";") {
        source += vlq(); originalLine += vlq(); originalColumn += vlq();
        if (source < 0 || source >= this.sources.length || originalLine < 0 || originalLine > 2_147_483_647 || originalColumn < 0 || originalColumn > 2_147_483_647) invalid();
        mappedSource = source;
        if (position < mappings.length && mappings[position] !== "," && mappings[position] !== ";") {
          name += vlq();
          if (name < 0 || name >= this.names.length) invalid();
          mappedName = name;
        }
      }
      if (position < mappings.length && mappings[position] !== "," && mappings[position] !== ";") invalid();
      buffer[used++] = line; buffer[used++] = column; buffer[used++] = mappedSource;
      buffer[used++] = originalLine; buffer[used++] = originalColumn; buffer[used++] = mappedName;
      if (mappings[position] === ",") {
        position++;
        if (position === mappings.length || mappings[position] === ";") invalid();
      }
    }
    this.segments = buffer;
    this.weight = 1024 + this.segments.byteLength + 2 * (this.root.length + this.sources.reduce((sum, item) => sum + item.length, 0) + this.names.reduce((sum, item) => sum + item.length, 0)
      + this.contents.reduce((sum, item) => sum + (item?.length ?? 0), 0)) + (this.sources.length + this.names.length) * 32;
  }

  lookup(lineno: number, colno: number): OriginalLocation | null {
    let low = 0, high = this.segments.length / 6;
    while (low < high) {
      const mid = (low + high) >>> 1;
      const row = mid * 6;
      if (this.segments[row]! < lineno - 1 || (this.segments[row] === lineno - 1 && this.segments[row + 1]! <= colno - 1)) low = mid + 1;
      else high = mid;
    }
    const row = (low - 1) * 6;
    if (row < 0 || this.segments[row] !== lineno - 1 || this.segments[row + 2]! < 0) return null;
    const source = this.segments[row + 2]!;
    const originalLine = this.segments[row + 3]!;
    const name = this.segments[row + 5]!;
    const filename = this.sourceName(this.sources[source]!);
    const result: OriginalLocation = { filename, lineno: originalLine + 1, colno: this.segments[row + 4]! + 1 };
    if (name >= 0) result.function = this.names[name];
    const content = this.contents[source];
    if (content !== undefined && content !== null) {
      // Scan only far enough to obtain five context lines, without splitting a large source into an array.
      let start = 0, index = 0;
      const context: string[] = [];
      while (start <= content.length && index <= originalLine + 2) {
        const end = content.indexOf("\n", start);
        if (index >= originalLine - 2) context.push(content.slice(start, end < 0 ? content.length : end).replace(/\r$/, "").slice(0, 500));
        if (end < 0) break;
        start = end + 1; index++;
      }
      const at = Math.min(originalLine, 2);
      if (context[at] !== undefined) {
        result.context_line = context[at]; result.pre_context = context.slice(0, at); result.post_context = context.slice(at + 1);
      }
    }
    return result;
  }

  private sourceName(source: string) {
    if (!this.root || /^[a-z][a-z\d+.-]*:/i.test(source) || source.startsWith("/")) return source;
    const root = `${this.root.replace(/\/$/, "")}/`;
    try { return new URL(source, root).href; }
    catch { return `${root}${source}`; }
  }
}

export function parseMap(bytes: Uint8Array): SourceMap {
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { invalid(); }
  if (!object(raw)) invalid();
  return new SourceMap(raw);
}
