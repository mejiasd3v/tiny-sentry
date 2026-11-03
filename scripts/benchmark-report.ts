import assert from "node:assert/strict";
import { percentile } from "./benchmark-load";

interface Run {
  repeat: number;
  stages: { workload: { name: string }; accepted: number; acceptedPerSecond: number; httpLatencyMs: { p95: number } }[];
  memory: { phase: string; medianWorkingSetBytes: number | null; sampledPeakWorkingSetBytes: number | null }[];
}
const result = await Bun.file(process.argv[2] || "benchmarks/results.json").json() as {
  runs: Run[]; environment: { docker: { arch: string }; limits: { cpus: number; memoryBytes: number } };
};
assert(result.runs.length > 0);
const phases = result.runs[0]!.memory.map((entry) => entry.phase);
const rows = phases.map((phase) => {
  const memory = result.runs.map((run) => run.memory.find((entry) => entry.phase === phase)!);
  const medians = memory.flatMap((entry) => entry.medianWorkingSetBytes === null ? [] : [entry.medianWorkingSetBytes / 1024 ** 2]);
  const peaks = memory.flatMap((entry) => entry.sampledPeakWorkingSetBytes === null ? [] : [entry.sampledPeakWorkingSetBytes / 1024 ** 2]);
  const stages = result.runs.flatMap((run) => run.stages.filter((entry) => entry.workload.name === phase));
  return { phase, median: medians.length ? percentile(medians, 0.5) : null, peak: peaks.length ? Math.max(...peaks) : null,
    rate: stages.length ? percentile(stages.map((entry) => entry.acceptedPerSecond), 0.5) : null,
    p95: stages.length ? percentile(stages.map((entry) => entry.httpLatencyMs.p95), 0.5) : null };
});
const format = (value: number | null) => value === null ? "—" : value.toFixed(2);
console.log("| Phase | Median working set (MiB) | Highest sampled working set (MiB) | Accepted/s, median | HTTP p95 (ms), median |\n| --- | ---: | ---: | ---: | ---: |");
for (const row of rows) console.log(`| ${row.phase} | ${format(row.median)} | ${format(row.peak)} | ${format(row.rate)} | ${format(row.p95)} |`);

const max = Math.ceil(Math.max(...rows.flatMap((row) => row.peak === null ? [] : [row.peak])) / 10) * 10;
const barX = 155;
const width = 460;
const bars = rows.map((row, index) => {
  if (row.median === null || row.peak === null) return "";
  const y = 100 + index * 46;
  return `<text x="18" y="${y + 19}" fill="#cbd5e1" font-size="14">${row.phase}</text>
  <rect x="${barX}" y="${y}" width="${row.peak / max * width}" height="28" rx="3" fill="#334155"/>
  <rect x="${barX}" y="${y}" width="${row.median / max * width}" height="28" rx="3" fill="#38bdf8"/>
  <text x="${barX + row.peak / max * width + 8}" y="${y + 19}" fill="#e2e8f0" font-size="13">${row.median.toFixed(1)} / ${row.peak.toFixed(1)}</text>`;
}).join("\n");
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="760" height="490" viewBox="0 0 760 490" role="img" aria-labelledby="title desc">
<title id="title">tiny-sentry container memory</title>
<desc id="desc">MiB: median of each run's median in blue, highest Docker sample in gray. ${result.runs.length} runs. Sentry memory was not measured by this chart.</desc>
<rect width="760" height="490" rx="12" fill="#0f172a"/>
<g font-family="system-ui, sans-serif">
<text x="18" y="35" fill="#f8fafc" font-size="22" font-weight="600">tiny-sentry container memory</text>
<text x="18" y="61" fill="#94a3b8" font-size="13">MiB · median / highest sample · ${result.runs.length} runs · Linux ${result.environment.docker.arch} · ${result.environment.limits.cpus} CPU · ${result.environment.limits.memoryBytes / 1024 ** 2} MiB limit</text>
${bars}
<text x="18" y="450" fill="#94a3b8" font-size="12">Docker working set, sampled by Docker. Load generator runs outside the container.</text>
<text x="18" y="471" fill="#94a3b8" font-size="12">Synthetic local workload. Does not measure Railway billing or Sentry's memory.</text>
</g></svg>\n`;
await Bun.write("benchmarks/memory.svg", svg);

interface Comparison {
  label: string;
  observations: {
    result: { accepted: number; verified: number; missing: number; acceptedPerSecond: number; httpLatencyMs: { p95: number }; verificationSeconds: number };
    before: { containers: { MemUsage: string }[] };
    afterAcknowledgement: { containers: { MemUsage: string }[] };
    afterVerification: { containers: { MemUsage: string }[] };
  }[];
}
const tinyFile = Bun.file("benchmarks/tiny-comparison.json");
const sentryFile = Bun.file("benchmarks/sentry-comparison.json");
if (await tinyFile.exists() && await sentryFile.exists()) {
  function workingSet(snapshot: Comparison["observations"][number]["before"]) {
    const units: Record<string, number> = { B: 1, kB: 1000, MB: 1e6, GB: 1e9, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 };
    return snapshot.containers.reduce((sum, entry) => {
      const match = entry.MemUsage.match(/^([\d.]+)([a-zA-Z]+)/);
      assert(match && units[match[2]!], "Unknown Docker memory format");
      return sum + Number(match[1]) * units[match[2]!]! / 1024 ** 2;
    }, 0);
  }
  const targets = [await tinyFile.json(), await sentryFile.json()] as Comparison[];
  const range = (values: number[]) => `${percentile(values, 0.5).toFixed(2)} (${Math.min(...values).toFixed(2)}–${Math.max(...values).toFixed(2)})`;
  const metrics: [string, (entry: Comparison["observations"][number]) => number][] = [
    ["HTTP acknowledgements/s", (entry) => entry.result.acceptedPerSecond],
    ["HTTP acknowledgement p95, ms", (entry) => entry.result.httpLatencyMs.p95],
    ["Post-load event verification scan, seconds", (entry) => entry.result.verificationSeconds],
    ["Pre-batch working set, MiB", (entry) => workingSet(entry.before)],
    ["After acknowledgement working set, MiB", (entry) => workingSet(entry.afterAcknowledgement)],
    ["After verification working set, MiB", (entry) => workingSet(entry.afterVerification)],
  ];
  console.log("\nComparison: median (min–max) across repetitions\n");
  console.log(`| Metric | ${targets.map((target) => target.label).join(" | ")} |\n| --- | ---: | ---: |`);
  for (const [name, select] of metrics) console.log(`| ${name} | ${targets.map((target) => range(target.observations.map(select))).join(" | ")} |`);
  const memory = targets.map((target) => percentile(target.observations.map((entry) => workingSet(entry.before)), 0.5));
  const scale = Math.ceil(Math.max(...memory) / 1024) * 1024;
  const comparison = `<svg xmlns="http://www.w3.org/2000/svg" width="760" height="310" viewBox="0 0 760 310" role="img" aria-labelledby="title desc">
<title id="title">Local working-set comparison for error ingestion</title>
<desc id="desc">Pre-batch Docker working-set snapshots, median across three batches: tiny-sentry ${memory[0]!.toFixed(2)} MiB, Sentry errors-only ${memory[1]!.toFixed(2)} MiB. Different resource allocations and product capabilities.</desc>
<rect width="760" height="310" rx="12" fill="#0f172a"/><g font-family="system-ui, sans-serif">
<text x="18" y="35" fill="#f8fafc" font-size="22" font-weight="600">Error ingestion: local memory observations</text>
<text x="18" y="62" fill="#94a3b8" font-size="13">Pre-batch working set · median across ${targets[0]!.observations.length} batches · linear scale from 0 to ${scale} MiB</text>
${memory.map((value, index) => `<text x="18" y="${119 + index * 65}" fill="#e2e8f0" font-size="14">${index ? "Sentry errors-only" : "tiny-sentry"} (${targets[index]!.observations[0]!.before.containers.length} ${targets[index]!.observations[0]!.before.containers.length === 1 ? "service" : "services"})</text>
<rect x="255" y="${97 + index * 65}" width="${value / scale * 385}" height="32" rx="2" fill="${index ? "#a78bfa" : "#38bdf8"}"/>
<text x="${263 + value / scale * 385}" y="${119 + index * 65}" fill="#f8fafc" font-size="14">${value.toFixed(1)} MiB</text>`).join("\n")}
<text x="18" y="234" fill="#94a3b8" font-size="12">tiny-sentry: 1 CPU / 128 MiB cap. Sentry: unrestricted within the shared 12-CPU / ~8 GB Docker VM.</text>
<text x="18" y="258" fill="#94a3b8" font-size="12">Snapshots are not load peaks. Both use warmed projects. Local ARM64 results, not Railway metrics.</text>
<text x="18" y="282" fill="#94a3b8" font-size="12">Sentry provides more features in this mode. This is not a feature-equivalent capacity comparison.</text>
</g></svg>\n`;
  await Bun.write("benchmarks/comparison.svg", comparison);
}
