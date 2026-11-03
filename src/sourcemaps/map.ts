import { HTTPException } from "hono/http-exception";
import { InvalidSourceMap, parseSourceMap, SourceMapLimit } from "./codec";
export { debugId, SourceMap, type OriginalLocation } from "./codec";

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
    // The Next.js SDK can rewrite browser filenames with the same app:/// prefix as server frames.
    const nextBrowser = url.protocol === "app:" && !url.host && url.pathname.startsWith("/_next/static/");
    return ["http:", "https:"].includes(url.protocol) || nextBrowser ? `~${url.pathname}` : undefined;
  } catch { return undefined; }
}

export function parseMap(bytes: Uint8Array, maxDecodedBytes?: number) {
  try { return parseSourceMap(bytes, maxDecodedBytes); }
  catch (error) {
    if (error instanceof SourceMapLimit) throw new HTTPException(413, { message: error.message });
    if (error instanceof InvalidSourceMap) throw new HTTPException(400, { message: error.message });
    throw error;
  }
}
