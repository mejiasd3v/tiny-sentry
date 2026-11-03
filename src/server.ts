import { createApp } from "./app";
import { loadConfig } from "./config";
import { Store } from "./store";
import { createDispatcher, loadDeliveries } from "./integrations/runtime";

const config = loadConfig();
const deliveries = await loadDeliveries(config);
const store = new Store(config);
store.prune();
store.outbox.reconcile(config.integrations);
const dispatcher = config.integrations.length ? createDispatcher(store.outbox, deliveries) : undefined;
const app = createApp(config, store, dispatcher?.wake);
const server = Bun.serve({
  port: config.port, hostname: "0.0.0.0", fetch: app.fetch,
  maxRequestBodySize: config.maxRequestBytes,
  idleTimeout: 15,
});
dispatcher?.wake();
const maintenance = setInterval(() => {
  try { store.prune(); }
  catch { console.error(JSON.stringify({ type: "maintenance_failed" })); }
}, 3_600_000);
maintenance.unref();
console.log(JSON.stringify({ type: "listening", port: server.port, projects: Object.keys(config.projects) }));

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(maintenance);
  const deadline = setTimeout(() => process.exit(1), 10_000);
  deadline.unref();
  await server.stop();
  await dispatcher?.stop();
  store.close();
  clearTimeout(deadline);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
