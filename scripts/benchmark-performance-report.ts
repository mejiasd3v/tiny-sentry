import assert from "node:assert/strict";
import { percentile } from "./benchmark-load";

interface Latency { p50: number; p95: number; p99: number }
interface Run {
  image: string;
  stages: { workload: { name: string }; accepted: number; verified: number; missing: number;
    acceptedPerSecond: number; httpLatencyMs: Latency }[];
  visibility: { accepted: number; verified: number; missing: number; timeToQueryMs: Latency };
  personal: { accepted: number; verified: number; missing: number; httpLatencyMs: Latency };
  final: { snapshot: { rssKiB: number; rssHighWaterKiB: number }; retained: { events: number; issues: number } };
}
const result = await Bun.file("benchmarks/performance.json").json() as {
  environment: { images: { name: string }[]; repetitions: number }; runs: Run[];
};
assert.equal(result.environment.images.length, 2, "Report expects baseline and optimized images");
const targets = result.environment.images.map(({ name }) => result.runs.filter((run) => run.image === name));
for (const runs of targets) assert.equal(runs.length, result.environment.repetitions, "Incomplete benchmark");
const median = (values: number[]) => percentile(values, 0.5);
const range = (values: number[]) => `${median(values).toFixed(2)} (${Math.min(...values).toFixed(2)}–${Math.max(...values).toFixed(2)})`;
const phases = ["below-cap", "at-cap", "many-issues"];
const metrics: [string, (run: Run) => number][] = phases.flatMap((phase) => [
  [`${phase}: HTTP acknowledgements/s`, (run: Run) => run.stages.find((stage) => stage.workload.name === phase)!.acceptedPerSecond],
  [`${phase}: HTTP p95, ms`, (run: Run) => run.stages.find((stage) => stage.workload.name === phase)!.httpLatencyMs.p95],
]);
metrics.push(
  ["Paired POST/GET time-to-query p95, ms", (run) => run.visibility.timeToQueryMs.p95],
  ["Paced personal workload HTTP p95, ms", (run) => run.personal.httpLatencyMs.p95],
  ["Final process RSS, MiB", (run) => run.final.snapshot.rssKiB / 1024],
  ["Process RSS high-water mark, MiB", (run) => run.final.snapshot.rssHighWaterKiB / 1024],
);
for (const run of result.runs) {
  for (const stage of [...run.stages, run.visibility, run.personal]) {
    assert.equal(stage.accepted, stage.verified);
    assert.equal(stage.missing, 0);
  }
  assert.equal(run.final.retained.events, 10000);
}
const table = "| Metric | Before | Optimized |\n| --- | ---: | ---: |\n" + metrics.map(([label, select]) =>
  `| ${label} | ${targets.map((runs) => range(runs.map(select))).join(" | ")} |`,
).join("\n");
console.log(table);
const rates = phases.map((phase) => targets.map((runs) => median(runs.map((run) =>
  run.stages.find((stage) => stage.workload.name === phase)!.acceptedPerSecond,
))));
const max = Math.ceil(Math.max(...rates.flat()) / 1000) * 1000;
const chart = `<svg xmlns="http://www.w3.org/2000/svg" width="760" height="430" viewBox="0 0 760 430" role="img" aria-labelledby="title desc">
<title id="title">tiny-sentry before and after optimization</title>
<desc id="desc">Median HTTP acknowledgements per second across ${result.environment.repetitions} runs; higher is better. ${phases.map((phase, index) => `${phase}: before ${rates[index]![0]!.toFixed(0)}, optimized ${rates[index]![1]!.toFixed(0)}.`).join(" ")} Sentry was not rerun.</desc>
<rect width="760" height="430" rx="12" fill="#0f172a"/>
<g font-family="system-ui, sans-serif">
<text x="20" y="34" fill="#f8fafc" font-size="22" font-weight="600">tiny-sentry: measured ingestion throughput</text>
<text x="20" y="61" fill="#94a3b8" font-size="13">Bun 1.4.4 · 1 CPU / 128 MiB · median of ${result.environment.repetitions} runs · local Linux ARM64</text>
<text x="20" y="89" fill="#94a3b8" font-size="13">Gray: before · blue: optimized · same workload and resource limits</text>
${phases.map((phase, index) => `<text x="20" y="${137 + index * 85}" fill="#e2e8f0" font-size="14">${phase}</text>` + rates[index]!.map((rate, target) => {
  const y = 111 + index * 85 + target * 28;
  const width = rate / max * 440;
  return `<rect x="145" y="${y}" width="${width}" height="22" rx="2" fill="${target ? "#38bdf8" : "#64748b"}"/><text x="${153 + width}" y="${y + 16}" fill="#e2e8f0" font-size="13">${rate.toFixed(0)}/s</text>`;
}).join("\n")).join("\n")}
<text x="20" y="392" fill="#94a3b8" font-size="12">Linear scale from zero to ${max}/s. Synthetic closed-loop workload; not a capacity guarantee.</text>
<text x="20" y="413" fill="#94a3b8" font-size="12">This compares tiny-sentry versions. It does not establish a performance win over Sentry.</text>
</g></svg>\n`;
await Bun.write("benchmarks/performance.svg", chart);
const path = "benchmarks/PERFORMANCE.md";
const document = await Bun.file(path).text();
assert(document.includes("<!-- performance-table -->") && document.includes("<!-- /performance-table -->"));
await Bun.write(path, document.replace(/<!-- performance-table -->[\s\S]*?<!-- \/performance-table -->/,
  `<!-- performance-table -->\n${table}\n<!-- /performance-table -->`,
));
