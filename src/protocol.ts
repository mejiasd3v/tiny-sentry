import { HTTPException } from "hono/http-exception";

export type JsonObject = Record<string, unknown>;

export function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseObject(bytes: Uint8Array): JsonObject {
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (object(value)) return value;
  } catch { /* Invalid JSON is a client error. */ }
  throw new HTTPException(400, { message: "Expected a JSON object" });
}

export async function readBounded(stream: ReadableStream<Uint8Array> | null, limit: number): Promise<Uint8Array> {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new HTTPException(413, { message: "Request too large" });
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

export async function readBody(request: Request, limit: number): Promise<Uint8Array> {
  const encoding = request.headers.get("content-encoding")?.toLowerCase();
  if (encoding && encoding !== "identity" && encoding !== "gzip" && encoding !== "deflate") {
    throw new HTTPException(415, { message: "Unsupported content encoding" });
  }
  const bytes = await readBounded(request.body, limit);
  if (encoding !== "gzip" && encoding !== "deflate") return bytes;
  try {
    return await readBounded(new Blob([new Uint8Array(bytes)]).stream().pipeThrough(new DecompressionStream(encoding)), limit);
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    throw new HTTPException(400, { message: "Invalid compressed body" });
  }
}

export interface Envelope {
  headers: JsonObject;
  events: JsonObject[];
}

// Envelope lengths count UTF-8 bytes, not JS characters. Unsupported binary
// items must still be consumed exactly so the next event remains parseable.
export function parseEnvelope(bytes: Uint8Array): Envelope {
  let position = 0;
  function line(): Uint8Array {
    let end = bytes.indexOf(10, position);
    if (end < 0) end = bytes.length;
    const value = bytes.subarray(position, end);
    position = Math.min(end + 1, bytes.length);
    return value;
  }
  const headers = parseObject(line());
  const events: JsonObject[] = [];
  let items = 0;
  while (position < bytes.length) {
    if (++items > 100) throw new HTTPException(400, { message: "Too many envelope items" });
    const item = parseObject(line());
    let payload: Uint8Array;
    if (item.length !== undefined) {
      if (!Number.isSafeInteger(item.length) || Number(item.length) < 0 || Number(item.length) > bytes.length - position) {
        throw new HTTPException(400, { message: "Invalid envelope item length" });
      }
      const end = position + Number(item.length);
      payload = bytes.subarray(position, end);
      position = end;
      if (position < bytes.length) {
        if (bytes[position] !== 10) throw new HTTPException(400, { message: "Missing envelope item separator" });
        position++;
      }
    } else {
      payload = line();
    }
    if (item.type === "event") {
      const event = parseObject(payload);
      if (event.event_id === undefined && headers.event_id !== undefined) event.event_id = headers.event_id;
      events.push(event);
    }
  }
  return { headers, events };
}
