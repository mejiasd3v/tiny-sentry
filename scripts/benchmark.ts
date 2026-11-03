import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, cpus, totalmem } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { load, percentile, workloads } from "./benchmark-load";

const image = process.env.BENCH_IMAGE || "tiny-sentry:benchmark";
const repeats = Number(process.env.BENCH_REPEATS || 3);
assert(Number.isInteger(repeats) && repeats > 0 && repeats <= 20);
const directory = mkdtempSync(join(tmpdir(), "tiny-sentry-benchmark-"));
const key = "a".repeat(32);
const admin = "b".repeat(64);
const envFile = join(directory, "env");
writeFileSync(envFile, `ADMIN_TOKEN=${admin}\nSENTRY_PROJECTS={"1":"${key}"}\nRATE_LIMIT_PER_MINUTE=1000000\n`, { mode: 0o600 });

async function docker(...args: string[]) {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  assert.equal(exit, 0, `docker ${args[0]}: ${err}`);
  return out.trim();
}

function bytes(usage: string) {
  const match = usage.match(/^([\d.]+)([a-zA-Z]+)/);
  assert(match, `Unknown Docker memory format: ${usage}`);
  const units: Record<string, number> = { B: 1, kB: 1000, MB: 1e6, GB: 1e9, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 };
  assert(units[match[2]!]);
  return Number(match[1]) * units[match[2]!]!;
}

const runs: unknown[] = [];
let container: string | undefined;
let sampler: ReturnType<typeof Bun.spawn> | undefined;
try {
  const metadata = {
    recordedAt: new Date().toISOString(), sourceCommit: await new Response(Bun.spawn(["git", "rev-parse", "HEAD"], { stdout: "pipe" }).stdout).text(),
    image: JSON.parse(await docker("image", "inspect", image, "--format", "{{json .}}")),
    docker: JSON.parse(await docker("info", "--format", "{{json .}}")),
    host: { platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryBytes: totalmem(), bun: Bun.version },
    limits: { cpus: 1, memoryBytes: 128 * 1024 ** 2, swap: false, maxEvents: 10000, maxDbMiB: 256, rateLimitPerMinute: 1000000 },
    repetitions: repeats,
  };
  // Keep only public, relevant metadata; Docker info/inspect can include local paths and registry configuration.
  const environment = {
    ...metadata, image: { id: metadata.image.Id, arch: metadata.image.Architecture, sizeBytes: metadata.image.Size },
    docker: { version: metadata.docker.ServerVersion, kernel: metadata.docker.KernelVersion,
      os: metadata.docker.OperatingSystem, arch: metadata.docker.Architecture, cpus: metadata.docker.NCPU, memoryBytes: metadata.docker.MemTotal },
  };
  for (let repeat = 1; repeat <= repeats; repeat++) {
    const data = join(directory, `data-${repeat}`);
    mkdirSync(data);
    container = await docker("run", "--rm", "-d", "--cpus=1", "--memory=128m", "--memory-swap=128m", "--env-file", envFile,
      "--mount", `type=bind,source=${data},target=/data`, "-p", "127.0.0.1::3000", image);
    const port = (await docker("port", container, "3000/tcp")).split(":").at(-1);
    const url = `http://127.0.0.1:${port}`;
    let healthy = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { healthy = (await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) })).ok; } catch { /* Listener startup. */ }
      if (healthy) break;
      await Bun.sleep(100);
    }
    assert(healthy, "Container did not start");
    let phase = "idle";
    const samples: { phase: string; elapsedSeconds: number; workingSetBytes: number; cpuPercent: number }[] = [];
    const samplingStarted = performance.now();
    const stats = Bun.spawn(["docker", "stats", "--format", "{{json .}}", container], { stdout: "pipe", stderr: "pipe" });
    sampler = stats;
    const readSamples = (async () => {
      let buffer = "";
      const reader = stats.stdout.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += new TextDecoder().decode(value);
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).replace(/\x1b\[[\d;]*[a-zA-Z]/g, "").trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          const stat = JSON.parse(line) as { MemUsage: string; CPUPerc: string };
          samples.push({ phase, elapsedSeconds: (performance.now() - samplingStarted) / 1000,
            workingSetBytes: bytes(stat.MemUsage), cpuPercent: Number.parseFloat(stat.CPUPerc) });
        }
      }
    })();
    async function snapshot() {
      const status = await docker("exec", container!, "cat", "/proc/1/status");
      const rss = Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1]);
      const highWater = Number(status.match(/^VmHWM:\s+(\d+)/m)?.[1]);
      assert(Number.isFinite(rss) && Number.isFinite(highWater));
      const rollup = await docker("exec", container!, "cat", "/proc/1/smaps_rollup");
      const residentBreakdownBytes = Object.fromEntries([...rollup.matchAll(/^(\w+):\s+(\d+) kB/gm)].map((match) => [match[1], Number(match[2]) * 1024]));
      const db = new Database(join(data, "tiny-sentry.sqlite"), { readonly: true });
      try {
        const counts = db.query<{ events: number; issues: number }, []>("SELECT (SELECT COUNT(*) FROM events) AS events, (SELECT COUNT(*) FROM issues) AS issues").get()!;
        const sizes = await docker("exec", container!, "sh", "-c", "wc -c /data/tiny-sentry.sqlite*");
        return { rssBytes: rss * 1024, rssHighWaterBytes: highWater * 1024, residentBreakdownBytes, ...counts, files: sizes };
      } finally { db.close(); }
    }
    await Bun.sleep(10_000);
    const idle = await snapshot();
    const stages = [];
    let totalAccepted = 0;
    let expectedIssues = 0;
    for (const workload of workloads) {
      phase = workload.name;
      console.error(`Run ${repeat}/${repeats}: ${phase}`);
      const { ids, ...result } = await load(`http://${key}@127.0.0.1:${port}/1`, workload);
      totalAccepted += result.accepted;
      assert.equal(result.accepted, workload.count, JSON.stringify(result.status));
      const snapshotAfter = await snapshot();
      assert.equal(snapshotAfter.events, Math.min(totalAccepted, 10000), "Accepted events were not retained as expected");
      expectedIssues = workload.count >= 10000 ? workload.groups : expectedIssues + Math.min(workload.groups, workload.count);
      assert.equal(snapshotAfter.issues, expectedIssues, "Explicit fingerprints did not produce the expected groups");
      const latest = await fetch(`${url}/api/projects/1/events/${ids.at(-1)}`, { headers: { Authorization: `Bearer ${admin}` } });
      assert.equal(latest.status, 200, "Acknowledged event is not retrievable");
      await latest.arrayBuffer();
      stages.push({ ...result, snapshot: snapshotAfter });
    }
    phase = "cooldown";
    await Bun.sleep(15_000);
    const cooldown = await snapshot();
    stats.kill();
    await readSamples;
    await stats.exited;
    sampler = undefined;
    const memory = ["idle", ...workloads.map((entry) => entry.name), "cooldown"].map((name) => {
      const subset = samples.filter((sample) => sample.phase === name);
      return { phase: name, samples: subset.length, medianWorkingSetBytes: subset.length ? percentile(subset.map((entry) => entry.workingSetBytes), 0.5) : null,
        sampledPeakWorkingSetBytes: subset.length ? Math.max(...subset.map((entry) => entry.workingSetBytes)) : null };
    });
    runs.push({ repeat, idle, stages, cooldown, memory, samples });
    await docker("stop", container);
    container = undefined;
    await Bun.write(process.env.BENCH_OUTPUT || "benchmarks/results.json", JSON.stringify({ environment, runs }, null, 2) + "\n");
  }
} finally {
  sampler?.kill();
  if (container) await docker("stop", container);
  rmSync(directory, { recursive: true, force: true });
}
