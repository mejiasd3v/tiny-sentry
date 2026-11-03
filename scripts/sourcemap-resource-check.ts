import assert from "node:assert/strict";

// A resource probe, not a throughput benchmark. All credentials and source text are synthetic.
const memory = process.argv[2] || "128m";
const image = process.argv[3] || "tiny-sentry:verify";
const admin = "a".repeat(64), key = "b".repeat(32);
let container: string | undefined;

async function docker(...args: string[]) {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (status) throw new Error(`docker ${args[0]} failed: ${err}`);
  return out.trim();
}

try {
  container = await docker("run", "--rm", "-d", "--memory", memory, "--memory-swap", memory, "--cpus", "1",
    "-e", `ADMIN_TOKEN=${admin}`, "-e", `SENTRY_PROJECTS=${JSON.stringify({ "1": key })}`, "-e", "SOURCEMAPS_ENABLED=true",
    "-p", "127.0.0.1::3000", image);
  const port = (await docker("port", container, "3000/tcp")).split(":").at(-1);
  const url = `http://127.0.0.1:${port}`;
  let healthy = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    try { healthy = (await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) })).ok; }
    catch { /* The listener may not have started yet. */ }
    if (healthy) break;
    await Bun.sleep(100);
  }
  assert(healthy, "Container did not become healthy");
  const id = "12345678-1234-1234-1234-123456789abc";
  const body = JSON.stringify({ version: 3, sources: ["large.ts"], sourcesContent: ["x".repeat(4 * 1024 * 1024)],
    names: [], mappings: Array(300_000).fill("AAAA").join(","), debug_id: id });
  const uploaded = await fetch(`${url}/api/projects/1/sourcemaps`, { method: "POST", headers: { Authorization: `Bearer ${admin}` }, body });
  assert.equal(uploaded.status, 201, await uploaded.text());
  const event = await fetch(`${url}/api/1/store/?sentry_key=${key}`, { method: "POST", body: JSON.stringify({
    exception: { values: [{ type: "Error", value: "resource check", stacktrace: {
      frames: Array.from({ length: 100 }, () => ({ filename: "large.js", lineno: 1, colno: 1, debug_id: id })),
    } }] },
  }) });
  assert.equal(event.status, 200);
  const saved = await event.json() as { id: string };
  for (let index = 0; index < 10; index++) {
    const response = await fetch(`${url}/api/projects/1/events/${saved.id}`, { headers: { Authorization: `Bearer ${admin}` } });
    assert.equal(response.status, 200);
    const detail = await response.json() as { symbolication: { frames: { status: string }[] } };
    assert.equal(detail.symbolication.frames.length, 100);
    assert(detail.symbolication.frames.every((frame) => frame.status === "mapped"));
  }
  const status = await docker("exec", container, "cat", "/proc/1/status");
  const kib = (name: string) => Number(new RegExp(`^${name}:\\s+(\\d+)`, "m").exec(status)?.[1]);
  console.log(JSON.stringify({ date: new Date().toISOString(), image: await docker("inspect", "--format", "{{.Image}}", container),
    architecture: await docker("image", "inspect", "--format", "{{.Architecture}}", image),
    input_bytes: body.length, segments: 300_000, frames_per_read: 100, reads: 10,
    peak_rss_kib: kib("VmHWM"), rss_kib: kib("VmRSS"),
    cgroup_peak_bytes: Number(await docker("exec", container, "cat", "/sys/fs/cgroup/memory.peak")),
    cgroup_events: await docker("exec", container, "cat", "/sys/fs/cgroup/memory.events"),
    limit_bytes: Number(await docker("exec", container, "cat", "/sys/fs/cgroup/memory.max")), result: "passed" }, null, 2));
} finally { if (container) await docker("stop", container); }
