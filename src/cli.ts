import { loadConfig } from "./config";
import { Store } from "./store";

const [command, argument, ...options] = process.argv.slice(2);
const help = `tiny-sentry CLI

  bun run cli projects
  bun run cli issues [--project 1] [--status unresolved] [--limit 25] [--offset 0]
  bun run cli show <issue-id>
  bun run cli events <issue-id>
  bun run cli event <project-id> <event-id>
  bun run cli resolve <issue-id>
  bun run cli reopen <issue-id>
  bun run cli stats
  bun run cli integrations
  bun run cli deliveries [--limit 25] [--offset 0]
  bun run cli retry-delivery <delivery-id>
  bun run cli sourcemaps upload <directory> --project 1 [--release web@sha] [--dist web] [--url-prefix '~/assets/']
  bun run cli sourcemaps list --project 1 [--limit 25] [--offset 0]
  bun run cli sourcemaps delete <UUID> --project 1
  bun run cli backup <new-file-path>     Local database; run inside the service

Set TINY_SENTRY_URL (default http://localhost:3000) and ADMIN_TOKEN.
Output is JSON; pipe to jq if desired.`;

async function main() {
  if (!command || command === "help" || command === "--help") { console.log(help); return; }
  if (command === "backup") {
    if (!argument) throw new Error("Provide a new backup file path");
    const store = new Store(loadConfig());
    try { store.backup(argument); console.log(JSON.stringify({ backup: argument })); }
    finally { store.close(); }
    return;
  }
  const url = new URL(process.env.TINY_SENTRY_URL || "http://localhost:3000");
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("TINY_SENTRY_URL must use HTTP or HTTPS");
  if (!process.env.ADMIN_TOKEN) throw new Error("ADMIN_TOKEN is required");
  const init: RequestInit = {
    headers: { Authorization: `Bearer ${process.env.ADMIN_TOKEN}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(15_000), redirect: "error",
  };
  if (command === "sourcemaps") {
    const { sourceMapsCommand } = await import("./sourcemaps/cli");
    console.log(JSON.stringify(await sourceMapsCommand([argument, ...options].filter((value): value is string => value !== undefined), url, init), null, 2));
    return;
  }
  let path: string;
  switch (command) {
    case "projects": path = "/api/projects"; break;
    case "stats": path = "/api/stats"; break;
    case "integrations": path = "/api/integrations"; break;
    case "retry-delivery":
      if (!argument || !/^[a-f\d-]{36}$/i.test(argument)) throw new Error("Provide a delivery UUID");
      path = `/api/integrations/deliveries/${argument}/retry`;
      init.method = "POST";
      break;
    case "deliveries": case "issues": {
      const args = [argument, ...options].filter((value): value is string => value !== undefined);
      const query = new URLSearchParams();
      for (let index = 0; index < args.length; index += 2) {
        const name = args[index]!.replace(/^--/, "");
        const allowed = command === "issues" ? ["project", "status", "limit", "offset"] : ["limit", "offset"];
        if (!allowed.includes(name) || !args[index + 1]) throw new Error("Invalid list option");
        query.set(name, args[index + 1]!);
      }
      path = `/api/${command === "issues" ? "issues" : "integrations/deliveries"}?${query}`;
      break;
    }
    case "show": case "events": case "resolve": case "reopen": {
      if (!argument || !/^\d+$/.test(argument)) throw new Error("Provide a numeric issue ID");
      path = `/api/issues/${argument}${command === "events" ? "/events" : ""}`;
      if (command === "resolve" || command === "reopen") {
        init.method = "PATCH";
        init.body = JSON.stringify({ status: command === "resolve" ? "resolved" : "unresolved" });
      }
      break;
    }
    case "event":
      if (!argument || !options[0]) throw new Error("Provide a project ID and event ID");
      path = `/api/projects/${encodeURIComponent(argument)}/events/${encodeURIComponent(options[0])}`;
      break;
    default: throw new Error(`Unknown command: ${command}\n${help}`);
  }
  const response = await fetch(new URL(path, url), init);
  const body: unknown = await response.json();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(body)}`);
  console.log(JSON.stringify(body, null, 2));
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Command failed");
  process.exitCode = 1;
});
