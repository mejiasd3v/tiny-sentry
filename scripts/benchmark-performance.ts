import assert from "node:assert/strict";
import { cpus } from "node:os";
import { load, verify, visibility, type Workload } from "./benchmark-load";

const images = process.argv.slice(2);
assert(images.length >= 2, "Pass at least two Docker image names, baseline first");
const repeats = Number(process.env.BENCH_REPEATS || 3);
assert(Number.isInteger(repeats) && repeats >= 1 && repeats <= 20);
const output = process.env.BENCH_OUTPUT || "benchmarks/performance.json";
const key = "a".repeat(32);
const admin = "b".repeat(64);
const workload: Workload = { name: "burst", count: 2000, concurrency: 8, eventBytes: 2048, groups: 10 };

async function docker(...args: string[]) {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  assert.equal(exit, 0, `docker ${args[0]}: ${err}`);
  return out.trim();
}

const engine = JSON.parse(await docker("info", "--format", "{{json .}}"));
const environment = {
  recordedAt: new Date().toISOString(), generatorBun: Bun.version,
  host: { platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model },
  docker: { version: engine.ServerVersion, kernel: engine.KernelVersion, arch: engine.Architecture,
    cpus: engine.NCPU, memoryBytes: engine.MemTotal },
  images: await Promise.all(images.map(async (name) => ({ name,
    id: await docker("image", "inspect", name, "--format", "{{.Id}}"),
    bun: await docker("run", "--rm", name, "bun", "--version"),
    sourceSha256: await docker("run", "--rm", name, "sh", "-c", "sha256sum /app/src/*.ts"),
  }))),
  limits: { cpus: 1, memoryMiB: 128, swap: false, maxEvents: 10000, maxDbMiB: 256 },
  storage: "Fresh Docker named volume per run; no host bind mount",
  repetitions: repeats,
};
const runs: unknown[] = [];
let container: string | undefined;
let volume: string | undefined;
try {
  for (let repeat = 1; repeat <= repeats; repeat++) {
    // Reverse order each repetition to reduce consistently favoring one image.
    for (const image of repeat % 2 ? images : images.toReversed()) {
      console.error(`Performance run ${repeat}/${repeats}: ${image}`);
      volume = await docker("volume", "create", `tiny-sentry-perf-${crypto.randomUUID()}`);
      container = await docker("run", "-d", "--cpus=1", "--memory=128m", "--memory-swap=128m",
        "--mount", `type=volume,source=${volume},target=/data`, "-p", "127.0.0.1::3000",
        "-e", `ADMIN_TOKEN=${admin}`, "-e", `SENTRY_PROJECTS={"1":"${key}"}`,
        "-e", "RATE_LIMIT_PER_MINUTE=1000000", image);
      const port = (await docker("port", container, "3000/tcp")).split(":").at(-1);
      const url = `http://127.0.0.1:${port}`;
      const dsn = `http://${key}@127.0.0.1:${port}/1`;
      const api = `${url}/api/projects/1/events/{id}`;
      let healthy = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        try { healthy = (await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) })).ok; } catch { /* Startup. */ }
        if (healthy) break;
        await Bun.sleep(100);
      }
      assert(healthy, "Container failed to start");
      async function snapshot() {
        const stat = JSON.parse(await docker("stats", "--no-stream", "--format", "{{json .}}", container!));
        const status = await docker("exec", container!, "cat", "/proc/1/status");
        const cpu = await docker("exec", container!, "cat", "/sys/fs/cgroup/cpu.stat");
        return { dockerMemory: stat.MemUsage, rssKiB: Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1]),
          rssHighWaterKiB: Number(status.match(/^VmHWM:\s+(\d+)/m)?.[1]),
          cpuUsageUsec: Number(cpu.match(/^usage_usec (\d+)/m)?.[1]) };
      }
      async function stats() {
        const response = await fetch(`${url}/api/stats`, { headers: { Authorization: `Bearer ${admin}` } });
        assert.equal(response.status, 200);
        return await response.json() as { events: number; issues: number };
      }
      async function send(work: Workload) {
        const result = await load(dsn, work);
        assert.equal(result.accepted, work.count, JSON.stringify(result.status));
        return result;
      }
      await send({ ...workload, name: "warmup", count: 1000 });
      const stages = [];
      for (const phase of ["below-cap", "at-cap"] as const) {
        if (phase === "at-cap") await send({ ...workload, name: "prefill", count: 7000 });
        const before = await snapshot();
        const result = await verify(await send({ ...workload, name: phase }), api, admin);
        assert.equal(result.missing, 0);
        const after = await snapshot();
        const retained = await stats();
        assert.equal(retained.events, phase === "below-cap" ? 3000 : 10000);
        assert.equal(retained.issues, phase === "below-cap" ? 20 : 30);
        stages.push({ ...result, before, after, retained });
      }
      const queryable = await visibility(dsn, api, admin, { ...workload, name: "paired-visibility", count: 200 });
      assert.equal(queryable.accepted, 200);
      assert.equal(queryable.missing, 0);
      const personal = await verify(await send({ ...workload, name: "personal", count: 20, concurrency: 1, perSecond: 2 }), api, admin);
      assert.equal(personal.missing, 0);
      // Growing issue cardinality exposes cleanup scans hidden by ten-group bursts.
      await send({ ...workload, name: "many-issues-prefill", count: 1000, groups: 1000 });
      const beforeMany = await snapshot();
      const many = await verify(await send({ ...workload, name: "many-issues", count: 1000, groups: 1000 }), api, admin);
      assert.equal(many.missing, 0);
      const afterMany = await snapshot();
      const retainedMany = await stats();
      assert.equal(retainedMany.events, 10000);
      assert.equal(retainedMany.issues, 2040);
      stages.push({ ...many, before: beforeMany, after: afterMany, retained: retainedMany });
      const final = { snapshot: await snapshot(), retained: await stats() };
      assert.equal(final.retained.events, 10000);
      runs.push({ repeat, image, stages, visibility: queryable, personal, final });
      await Bun.write(output, JSON.stringify({ environment, runs }, null, 2) + "\n");
      await docker("stop", container);
      await docker("rm", container);
      container = undefined;
      await docker("volume", "rm", volume);
      volume = undefined;
    }
  }
} finally {
  if (container) { await docker("stop", container); await docker("rm", container); }
  if (volume) await docker("volume", "rm", volume);
}
