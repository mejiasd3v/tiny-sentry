import type { PreparedEvent } from "./event";
import type { Ingestion, Notice, Store } from "./store";

// Share a commit between requests already waiting in this event-loop turn.
// Flush early to bound queued payload bytes and request count. Every promise
// settles after the outer transaction commits or rolls back.
export function createIngestor(store: Store, maxBytes: number) {
  type Pending = Ingestion & { resolve: (notices: Notice[]) => void; reject: (error: unknown) => void };
  let pending: Pending[] = [];
  let bytes = 0;
  let scheduled: ReturnType<typeof setImmediate> | undefined;

  function flush() {
    if (scheduled) clearImmediate(scheduled);
    scheduled = undefined;
    if (!pending.length) return;
    const batch = pending;
    pending = [];
    bytes = 0;
    try {
      const results = store.ingestBatch(batch);
      batch.forEach((request, index) => request.resolve(results[index]!));
    } catch (error) {
      for (const request of batch) request.reject(error);
    }
  }

  return (project: string, events: PreparedEvent[]): Promise<Notice[]> => {
    const size = events.reduce((total, event) => total + Buffer.byteLength(event.payload), 0);
    if (bytes + size > maxBytes) flush();
    const result = Promise.withResolvers<Notice[]>();
    pending.push({ project, events, receivedAt: Date.now(), resolve: result.resolve, reject: result.reject });
    bytes += size;
    if (pending.length >= 32 || bytes >= maxBytes) flush();
    else scheduled ??= setImmediate(flush);
    return result.promise;
  };
}
