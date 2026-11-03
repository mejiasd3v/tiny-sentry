import assert from "node:assert/strict";

export interface Workload {
  name: string;
  count: number;
  concurrency: number;
  eventBytes: number;
  groups: number;
  perSecond?: number;
}

export const workloads: Workload[] = [
  { name: "personal", count: 60, concurrency: 1, eventBytes: 2048, groups: 10, perSecond: 2 },
  { name: "burst", count: 2000, concurrency: 8, eventBytes: 2048, groups: 10 },
  { name: "many-issues", count: 1000, concurrency: 8, eventBytes: 2048, groups: 1000 },
  { name: "large-events", count: 1000, concurrency: 8, eventBytes: 65536, groups: 10 },
  { name: "retention", count: 12000, concurrency: 32, eventBytes: 2048, groups: 10 },
];

export function percentile(values: number[], fraction: number) {
  assert(values.length > 0, "Measurement has no samples");
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!;
}

export async function load(dsn: string, workload: Workload) {
  const target = new URL(dsn);
  assert(["http:", "https:"].includes(target.protocol));
  const project = target.pathname.split("/").pop();
  assert(project && target.username, "Expected a Sentry DSN with public key and project ID");
  const endpoint = new URL(`${target.pathname.slice(0, -project.length)}api/${project}/envelope/`, target.origin);
  endpoint.searchParams.set("sentry_key", decodeURIComponent(target.username));
  const run = crypto.randomUUID();
  const ids: string[] = [];
  const latencies: number[] = [];
  const status: Record<string, number> = {};
  let next = 0;
  const startedAt = new Date().toISOString();
  const started = performance.now();
  await Promise.all(Array.from({ length: workload.concurrency }, async () => {
    while (next < workload.count) {
      const index = next++;
      if (workload.perSecond) {
        await Bun.sleep(Math.max(0, started + index * 1000 / workload.perSecond - performance.now()));
      }
      const id = crypto.randomUUID().replaceAll("-", "");
      const event = {
        event_id: id, timestamp: Date.now() / 1000, platform: "javascript", level: "error",
        environment: "benchmark", release: "benchmark@1.0.0",
        fingerprint: ["tiny-sentry-benchmark", run, String(index % workload.groups)],
        exception: { values: [{ type: "Error", value: "Synthetic benchmark exception", stacktrace: {
          frames: [{ filename: "app.ts", function: "handleRequest", lineno: 42, in_app: true }],
        } }] },
        tags: { benchmark_run: run },
        breadcrumbs: [{ timestamp: Date.now() / 1000, category: "app", message: "Synthetic request started" }],
        extra: { padding: "" },
      };
      const initial = JSON.stringify(event);
      assert(initial.length <= workload.eventBytes);
      event.extra.padding = "x".repeat(workload.eventBytes - Buffer.byteLength(initial));
      const payload = JSON.stringify(event);
      const body = `${JSON.stringify({ event_id: id })}\n${JSON.stringify({ type: "event", length: Buffer.byteLength(payload) })}\n${payload}\n`;
      const before = performance.now();
      try {
        const response = await fetch(endpoint, {
          method: "POST", headers: { "Content-Type": "application/x-sentry-envelope" }, body,
          signal: AbortSignal.timeout(30_000),
        });
        await response.arrayBuffer();
        status[response.status] = (status[response.status] ?? 0) + 1;
        if (response.ok) ids.push(id);
      } catch {
        status.network_error = (status.network_error ?? 0) + 1;
      }
      latencies.push(performance.now() - before);
    }
  }));
  const seconds = (performance.now() - started) / 1000;
  return {
    run, startedAt, acknowledgedAt: new Date().toISOString(), ids, workload, seconds, status, accepted: ids.length,
    acceptedPerSecond: ids.length / seconds,
    httpLatencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), p99: percentile(latencies, 0.99) },
  };
}

export async function verify(result: Awaited<ReturnType<typeof load>>, api: string, token: string) {
  assert(api.includes("{id}"), "BENCH_EVENT_API must include {id}");
  const pending = new Set(result.ids);
  const verificationStarted = performance.now();
  const deadline = verificationStarted + 120_000;
  let verified = 0;
  while (pending.size && performance.now() < deadline) {
    const queue = [...pending];
    let next = 0;
    await Promise.all(Array.from({ length: 8 }, async () => {
      while (next < queue.length && performance.now() < deadline) {
        const id = queue[next++]!;
        const response: Response = await fetch(api.replace("{id}", id), {
          headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000),
        });
        if (response.status === 401 || response.status === 403) throw new Error("Event verification authorization failed");
        if (response.ok) {
          const value = await response.json() as { eventID?: string; event?: { event_id?: string } };
          assert.equal(value.eventID ?? value.event?.event_id, id, "API returned a different event");
          pending.delete(id); verified++;
        } else {
          await response.arrayBuffer();
          assert.equal(response.status, 404, `Unexpected verification HTTP ${response.status}`);
        }
      }
    }));
    if (pending.size) await Bun.sleep(1000);
  }
  const { ids, ...summary } = result;
  return { ...summary, verified, missing: pending.size,
    verificationSeconds: (performance.now() - verificationStarted) / 1000,
    note: "HTTP latency measures acknowledgement. Verification is a separate post-load scan, not per-event processing latency.",
  };
}

// Use a disposable project: this writes real error events and does not delete them.
if (import.meta.main) {
  const dsn = process.env.BENCH_DSN;
  const api = process.env.BENCH_EVENT_API;
  const token = process.env.BENCH_API_TOKEN;
  assert(dsn && api && token, "Set BENCH_DSN, BENCH_EVENT_API (with {id}), and BENCH_API_TOKEN");
  const workload = workloads.find((entry) => entry.name === (process.env.BENCH_WORKLOAD || "burst"));
  assert(workload, "Unknown BENCH_WORKLOAD");
  const result = await verify(await load(dsn, workload), api, token);
  console.log(JSON.stringify(result, null, 2));
  if (result.missing || result.accepted !== workload.count) process.exitCode = 1;
}
