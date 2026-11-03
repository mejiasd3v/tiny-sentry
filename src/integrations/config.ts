import { createHash } from "node:crypto";
import { object } from "../protocol";
import type { IntegrationRule, Trigger } from "./types";

export function parseIntegrations(raw: string | undefined, projects: Record<string, string>): IntegrationRule[] {
  if (!raw) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error("INTEGRATIONS must be a JSON array"); }
  if (!Array.isArray(parsed) || parsed.length > 32) throw new Error("INTEGRATIONS must contain at most 32 rules");
  const ids = new Set<string>();
  return parsed.map((entry: unknown) => {
    // Never include raw config in errors: it can contain a destination or credentials.
    if (!object(entry) || typeof entry.id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(entry.id) || ids.has(entry.id)) {
      throw new Error("Integration IDs must be unique, 1-64 URL-safe characters");
    }
    ids.add(entry.id);
    const fail = () => new Error(`Invalid configuration for integration ${entry.id}`);
    if (Object.keys(entry).some((key) => !["id", "type", "trigger", "projects", "levels", "options"].includes(key)) ||
        typeof entry.type !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(entry.type) || !object(entry.options) || !object(entry.trigger)) throw fail();
    let trigger: Trigger;
    if (entry.trigger.type === "threshold") {
      if (Object.keys(entry.trigger).some((key) => key !== "type" && key !== "count") ||
          typeof entry.trigger.count !== "number" || !Number.isSafeInteger(entry.trigger.count) || entry.trigger.count < 1) throw fail();
      trigger = { type: "threshold", count: entry.trigger.count };
    } else if ((entry.trigger.type === "new_issue" || entry.trigger.type === "regression") && Object.keys(entry.trigger).length === 1) {
      trigger = { type: entry.trigger.type };
    } else throw fail();
    function strings(value: unknown): string[] | undefined {
      if (value === undefined) return undefined;
      if (!Array.isArray(value) || !value.length || value.some((part) => typeof part !== "string" || part.length > 64)) throw fail();
      return value;
    }
    const selectedProjects = strings(entry.projects);
    const levels = strings(entry.levels);
    if (selectedProjects?.some((id) => !Object.hasOwn(projects, id))) throw fail();
    const rule = { id: entry.id, type: entry.type, trigger, projects: selectedProjects, levels, options: entry.options };
    return { ...rule, revision: createHash("sha256").update(JSON.stringify(rule)).digest("hex") };
  });
}
