import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// An actual Linux server and volume, rather than Hono's in-process request API.
const directory = mkdtempSync(join(tmpdir(), "tiny-sentry-container-"));
const data = join(directory, "data");
const envFile = join(directory, "env");
const key = "a".repeat(32);
const admin = "b".repeat(64);
mkdirSync(data);
const integrations = [{ id: "smoke", type: "webhook", trigger: { type: "new_issue" }, options: { url: "http://127.0.0.1:1" } }];
writeFileSync(envFile, `ADMIN_TOKEN=${admin}\nSENTRY_PROJECTS={"1":"${key}"}\nMAX_REQUEST_BYTES=2048\nMAX_EVENT_BYTES=1024\nINTEGRATIONS=${JSON.stringify(integrations)}\n`, { mode: 0o600 });
let container: string | undefined;

async function docker(...args: string[]) {
  const process = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, exit] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
  if (exit !== 0) throw new Error(`docker ${args[0]} failed: ${err}`);
  return out.trim();
}

async function start() {
  container = await docker("run", "--rm", "-d", "--env-file", envFile, "--mount", `type=bind,source=${data},target=/data`, "-p", "127.0.0.1::3000", process.argv[2] || "tiny-sentry:verify");
  const port = (await docker("port", container, "3000/tcp")).split(":").at(-1);
  const url = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return url;
    } catch { /* Wait briefly for the container's listener to start. */ }
    await Bun.sleep(100);
  }
  throw new Error(`Container did not become healthy: ${await docker("logs", container)}`);
}

try {
  let url = await start();
  let response = await fetch(`${url}/api/1/store/?sentry_key=${key}`, {
    method: "POST", body: JSON.stringify({ message: "Linux container smoke test" }),
  });
  assert.equal(response.status, 200);
  const { id } = await response.json() as { id: string };
  response = await fetch(`${url}/api/integrations/deliveries`, { headers: { Authorization: `Bearer ${admin}` } });
  assert.equal(response.status, 200);
  const { deliveries } = await response.json() as { deliveries: { id: string; kind: string }[] };
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0]!.kind, "new_issue");
  response = await fetch(`${url}/api/1/store/?sentry_key=${key}`, { method: "POST", body: "x".repeat(3000) });
  assert.equal(response.status, 413, "Bun's network layer must reject oversized requests");
  const snapshot = await docker("stats", "--no-stream", "--format", "{{.MemUsage}}", container!);
  console.log(`Linux container memory after smoke request: ${snapshot}`);
  await docker("stop", container!);
  container = undefined;
  url = await start();
  response = await fetch(`${url}/api/projects/1/events/${id}`, { headers: { Authorization: `Bearer ${admin}` } });
  assert.equal(response.status, 200);
  const saved = await response.json() as { event: { message: string } };
  assert.equal(saved.event.message, "Linux container smoke test");
  const restored = JSON.parse(await docker("exec", container!, "bun", "src/cli.ts", "deliveries")) as { deliveries: { id: string }[] };
  assert.equal(restored.deliveries.length, 1);
  assert.equal(restored.deliveries[0]!.id, deliveries[0]!.id, "Outbox jobs must survive container recreation");
  console.log("PASS: container health, ingestion, request limit, graceful stop, CLI, and event/outbox persistence across recreation");
} finally {
  if (container) await docker("stop", container);
  rmSync(directory, { recursive: true, force: true });
}
