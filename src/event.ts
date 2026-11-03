import { createHash } from "node:crypto";
import { HTTPException } from "hono/http-exception";
import { object, type JsonObject } from "./protocol";

const sensitive = /authorization|cookie|password|passwd|secret|token|api[_-]?key|access[_-]?key|session[_-]?id|email|ip_address/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 30) return "[Truncated]";
  if (Array.isArray(value)) {
    // Header lists and some SDK tags use [key, value] tuples.
    if (value.length === 2 && typeof value[0] === "string" && sensitive.test(value[0])) {
      return [value[0], "[Filtered]"];
    }
    return value.map((item) => redact(item, depth + 1));
  }
  if (!object(value)) return value;
  const result: JsonObject = Object.create(null);
  for (const [key, entry] of Object.entries(value)) {
    if (sensitive.test(key)) result[key] = "[Filtered]";
    else if (key === "url" && typeof entry === "string") {
      try {
        const url = new URL(entry);
        url.username = ""; url.password = ""; url.search = ""; url.hash = "";
        result[key] = url.toString();
      } catch { result[key] = entry.split(/[?#]/, 1)[0]; }
    } else result[key] = redact(entry, depth + 1);
  }
  return result;
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export interface PreparedEvent {
  id: string;
  fingerprint: string;
  title: string;
  level: string;
  environment: string | null;
  release: string | null;
  payload: string;
}

export function prepareEvent(input: JsonObject, maxBytes: number): PreparedEvent | null {
  if (input.type !== undefined && input.type !== "error" && input.type !== "default") return null;
  if (Buffer.byteLength(JSON.stringify(input)) > maxBytes) {
    throw new HTTPException(413, { message: "Event too large" });
  }
  const id = input.event_id === undefined ? crypto.randomUUID().replaceAll("-", "") : input.event_id;
  if (typeof id !== "string" || !/^[a-f\d]{32}$/i.test(id)) {
    throw new HTTPException(400, { message: "event_id must be 32 hexadecimal characters" });
  }
  const cleaned = redact(input);
  if (!object(cleaned)) throw new Error("Redaction must return an object");
  // Request bodies, cookies and query strings are disproportionately sensitive.
  if (object(cleaned.request)) {
    delete cleaned.request.data;
    delete cleaned.request.cookies;
    delete cleaned.request.query_string;
  }
  cleaned.event_id = id.toLowerCase();
  const exception = object(cleaned.exception) && Array.isArray(cleaned.exception.values)
    ? cleaned.exception.values.filter(object).at(-1) : undefined;
  const logentry = object(cleaned.logentry) ? cleaned.logentry : undefined;
  const message = text(cleaned.message) || text(logentry?.formatted) || text(logentry?.message);
  const title = (exception ? [text(exception.type, "Error"), text(exception.value)].filter(Boolean).join(": ") : message || "Unknown error").slice(0, 500);
  const stack = exception && object(exception.stacktrace) && Array.isArray(exception.stacktrace.frames)
    ? exception.stacktrace.frames.filter(object) : [];
  const appFrames = stack.filter((frame) => frame.in_app === true);
  const frames = (appFrames.length ? appFrames : stack).slice(-10).map((frame) => [
    text(frame.module) || text(frame.filename).split(/[?#]/, 1)[0], text(frame.function),
  ]);
  // Exclude messages with changing IDs and line numbers when a stack is present.
  const defaultGroup = JSON.stringify([text(exception?.type), frames.length ? frames : text(logentry?.message) || title]);
  let group = defaultGroup;
  if (cleaned.fingerprint !== undefined) {
    if (!Array.isArray(cleaned.fingerprint) || !cleaned.fingerprint.length || cleaned.fingerprint.some((part) => typeof part !== "string")) {
      throw new HTTPException(400, { message: "fingerprint must be a nonempty array of strings" });
    }
    group = JSON.stringify(cleaned.fingerprint.map((part) => part === "{{ default }}" ? defaultGroup : part));
  }
  const payload = JSON.stringify(cleaned);
  if (Buffer.byteLength(payload) > maxBytes) throw new HTTPException(413, { message: "Event too large" });
  return {
    id: id.toLowerCase(), fingerprint: createHash("sha256").update(group).digest("hex"), title,
    level: text(cleaned.level, "error").slice(0, 32),
    environment: typeof cleaned.environment === "string" ? cleaned.environment.slice(0, 200) : null,
    release: typeof cleaned.release === "string" ? cleaned.release.slice(0, 200) : null,
    payload,
  };
}
