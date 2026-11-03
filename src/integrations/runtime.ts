import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Config } from "../config";
import { object } from "../protocol";
import { builtinPlugins } from "./plugins";
import { maxAttempts, type Outbox } from "./outbox";
import { DeliveryError, type Delivery, type IntegrationPlugin, type Notification } from "./types";

export async function loadDeliveries(config: Config, env: Record<string, string | undefined> = process.env): Promise<Map<string, Delivery>> {
  const plugins: Record<string, IntegrationPlugin> = Object.assign(Object.create(null), builtinPlugins);
  if (config.integrations.length && config.integrationsModule) {
    // Administrator-selected local code has the same privileges as the service.
    const loaded: unknown = (await import(pathToFileURL(resolve(config.integrationsModule)).href)).default;
    if (!object(loaded)) throw new Error("INTEGRATIONS_MODULE must default-export a plugin map");
    for (const [name, plugin] of Object.entries(loaded)) {
      if (!/^[a-z][a-z0-9_-]{0,63}$/.test(name) || Object.hasOwn(plugins, name) || !object(plugin) || typeof plugin.create !== "function") {
        throw new Error("Invalid or duplicate custom integration type");
      }
      // Runtime boundary checked above; implementations must satisfy the documented TS contract.
      plugins[name] = plugin as unknown as IntegrationPlugin;
    }
  }
  const deliveries = new Map<string, Delivery>();
  for (const rule of config.integrations) {
    try {
      const plugin = plugins[rule.type];
      if (!plugin) throw new Error("Unknown plugin");
      const delivery = plugin.create(rule.options, env);
      if (!delivery || typeof delivery.send !== "function") throw new Error("Invalid plugin factory result");
      deliveries.set(`${rule.id}:${rule.revision}`, delivery);
    } catch {
      // Provider errors, URLs and options may contain credentials.
      throw new Error(`Cannot initialize integration ${rule.id}; check type, options and secret environment variables`);
    }
  }
  return deliveries;
}

/** One bounded request at a time, no idle polling, no extra process. */
export function createDispatcher(outbox: Outbox, deliveries: Map<string, Delivery>, enrich: (notification: Notification) => Notification = (notification) => notification) {
  let running: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let stopped = false;

  async function drain() {
    while (!stopped) {
      const job = outbox.claim();
      if (!job) break;
      const delivery = deliveries.get(`${job.integration_id}:${job.revision}`);
      if (!delivery) { outbox.finish(job, "failed", Date.now()); continue; }
      controller = new AbortController();
      const signal = controller.signal;
      const deadline = setTimeout(() => controller?.abort(), 10_000);
      deadline.unref();
      const aborted = Promise.withResolvers<never>();
      const onAbort = () => aborted.reject(new DeliveryError(true));
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        const notification = enrich(JSON.parse(job.payload) as Notification);
        await Promise.race([
          delivery.send(notification, { signal, idempotencyKey: job.id }),
          aborted.promise,
        ]);
        outbox.finish(job, "delivered", Date.now());
        console.log(JSON.stringify({ type: "integration_delivered", integration_id: job.integration_id, delivery_id: job.id }));
      } catch (error) {
        const retryable = !(error instanceof DeliveryError) || error.retryable;
        const retry = retryable && job.attempts < maxAttempts;
        const backoff = Math.min(3_600_000, 1000 * 2 ** (job.attempts - 1));
        const delay = error instanceof DeliveryError && Number.isFinite(error.retryAfterMs) && error.retryAfterMs !== undefined
          ? Math.min(86_400_000, Math.max(backoff, error.retryAfterMs)) : backoff;
        outbox.finish(job, retry ? "pending" : "failed", Date.now() + delay);
        console.error(JSON.stringify({ type: retry ? "integration_retry" : "integration_failed", integration_id: job.integration_id, delivery_id: job.id,
          attempt: job.attempts, http_status: error instanceof DeliveryError ? error.httpStatus : undefined }));
      } finally {
        clearTimeout(deadline);
        signal.removeEventListener("abort", onAbort);
        controller = undefined;
      }
    }
  }

  function wake() {
    if (stopped || running) return;
    if (timer) clearTimeout(timer);
    timer = undefined;
    // Defer networking until after the ingestion continuation can send its response.
    running = Promise.resolve().then(drain).catch(() => {
      console.error(JSON.stringify({ type: "integration_worker_failed" }));
    }).finally(() => {
      running = undefined;
      if (stopped) return;
      try {
        const next = outbox.next();
        if (next !== null) timer = setTimeout(wake, Math.max(0, next - Date.now()));
      } catch {
        console.error(JSON.stringify({ type: "integration_worker_failed" }));
        timer = setTimeout(wake, 1000);
      }
      timer?.unref();
    });
  }

  return {
    wake,
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      controller?.abort();
      await running;
    },
  };
}
