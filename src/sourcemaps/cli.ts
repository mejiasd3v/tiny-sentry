import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { readBounded } from "../protocol";

export async function sourceMapsCommand(args: string[], base: URL, init: RequestInit): Promise<unknown> {
  const action = args.shift();
  const argument = args[0] && !args[0].startsWith("--") ? args.shift() : undefined;
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]!;
    const value = args[index + 1];
    const allowed = action === "upload" ? ["--project", "--release", "--dist", "--url-prefix"]
      : action === "list" ? ["--project", "--limit", "--offset"] : ["--project"];
    if (!allowed.includes(name) || !value || options.has(name)) throw new Error("Invalid source map option");
    options.set(name, value);
  }
  const project = options.get("--project");
  if (!project || !/^[1-9]\d{0,15}$/.test(project)) throw new Error("Provide --project <numeric project ID>");
  const path = `/api/projects/${project}/sourcemaps`;
  async function request(suffix: string, overrides: RequestInit = {}) {
    const response = await fetch(new URL(`${path}${suffix}`, base), { ...init, ...overrides, signal: AbortSignal.timeout(30_000) });
    const body: unknown = await response.json();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(body)}`);
    return body;
  }
  if (action === "list" && argument === undefined) {
    const query = new URLSearchParams();
    for (const name of ["limit", "offset"]) if (options.has(`--${name}`)) query.set(name, options.get(`--${name}`)!);
    return request(`?${query}`);
  }
  if (action === "delete" && argument && /^[a-f\d-]{36}$/i.test(argument)) return request(`/${argument}`, { method: "DELETE" });
  if (action !== "upload" || !argument) throw new Error("Use sourcemaps upload <directory>, list, or delete <UUID>, with --project <ID>");
  const release = options.get("--release");
  if (!release && (options.has("--dist") || options.has("--url-prefix"))) throw new Error("--dist and --url-prefix require --release");
  const directory = resolve(argument);
  const files: string[] = [];
  for await (const file of new Bun.Glob("**/*.map").scan({ cwd: directory, onlyFiles: true, followSymlinks: false })) {
    files.push(file);
    if (files.length > 1000) throw new Error("Upload at most 1000 source maps at a time");
  }
  if (!files.length) throw new Error("No .map files found");
  const uploaded: unknown[] = [];
  for (const file of files.sort()) {
    const bytes = await readBounded(Bun.file(resolve(directory, file)).stream(), 32 * 1024 * 1024);
    const query = new URLSearchParams();
    if (release) {
      query.set("release", release);
      query.set("url", `${(options.get("--url-prefix") ?? "~/").replace(/\/$/, "")}/${file.replaceAll("\\", "/").slice(0, -4)}`);
      if (options.has("--dist")) query.set("dist", options.get("--dist")!);
    }
    try {
      uploaded.push(await request(`?${query}`, { method: "POST", body: gzipSync(bytes),
        headers: { ...init.headers, "Content-Type": "application/json", "Content-Encoding": "gzip" } }));
    } catch (error) {
      throw new Error(`Upload stopped after ${uploaded.length}/${files.length} maps; earlier uploads remain stored. ${error instanceof Error ? error.message : "Upload failed"}`);
    }
  }
  return { uploaded: uploaded.length, artifacts: uploaded };
}
