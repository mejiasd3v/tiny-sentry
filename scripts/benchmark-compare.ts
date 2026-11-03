import assert from "node:assert/strict";
import { load, verify, workloads } from "./benchmark-load";

const dsn = process.env.BENCH_DSN;
const api = process.env.BENCH_EVENT_API;
const token = process.env.BENCH_API_TOKEN;
const label = process.env.BENCH_LABEL;
assert(dsn && api && token && label, "Set BENCH_DSN, BENCH_EVENT_API, BENCH_API_TOKEN, and BENCH_LABEL");
const containers = (process.env.BENCH_CONTAINERS || "").split(",").filter(Boolean);
const repeats = Number(process.env.BENCH_REPEATS || 3);
assert(Number.isInteger(repeats) && repeats > 0 && repeats <= 20);
const workload = workloads.find((entry) => entry.name === (process.env.BENCH_WORKLOAD || "burst"));
assert(workload && workload.count < 10000, "Select a comparison workload below the retention cap");

async function snapshot() {
  if (!containers.length) return null;
  const child = Bun.spawn(["docker", "stats", "--no-stream", "--format", "{{json .}}", ...containers], { stdout: "pipe", stderr: "pipe" });
  const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  assert.equal(exit, 0, err);
  const inspect = Bun.spawn(["docker", "inspect", "--format", "{{json .State}}", ...containers], { stdout: "pipe", stderr: "pipe" });
  const [states, inspectError, inspectExit] = await Promise.all([new Response(inspect.stdout).text(), new Response(inspect.stderr).text(), inspect.exited]);
  assert.equal(inspectExit, 0, inspectError);
  const health = states.trim().split("\n").map((line, index) => {
    const state = JSON.parse(line) as { Running: boolean; OOMKilled: boolean; ExitCode: number; Health?: { Status: string } };
    return { container: containers[index], running: state.Running, oomKilled: state.OOMKilled,
      exitCode: state.ExitCode, health: state.Health?.Status };
  });
  assert(health.every((state) => state.running && (!state.health || state.health === "healthy")), "A benchmark container is stopped or unhealthy");
  return { recordedAt: new Date().toISOString(), health, containers: out.trim().split("\n").map((line) => JSON.parse(line) as Record<string, string>) };
}

const observations = [];
const output = process.env.BENCH_OUTPUT || "benchmarks/comparison.json";
// Deliberately no DSN, URL, or bearer token in the artifact.
for (let repeat = 1; repeat <= repeats; repeat++) {
  const before = await snapshot();
  console.error(`${label}: run ${repeat}/${repeats}, ${workload.name}`);
  const loaded = await load(dsn, workload);
  const afterAcknowledgement = await snapshot();
  const result = await verify(loaded, api, token);
  const afterVerification = await snapshot();
  observations.push({ repeat, before, result, afterAcknowledgement, afterVerification });
  await Bun.write(output, JSON.stringify({ label, recordedAt: new Date().toISOString(),
    memoryMethod: "Docker working-set snapshots before load, after all HTTP acknowledgements, and after the event verification scan. These are not load peaks.",
    observations }, null, 2) + "\n");
  assert.equal(result.accepted, workload.count, "Ingestion failed; partial observations saved");
  assert.equal(result.missing, 0, "Acknowledged events could not be retrieved; observations saved");
  await Bun.sleep(5000);
}
