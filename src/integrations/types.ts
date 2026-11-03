import type { Issue } from "../store";

export type Trigger = { type: "new_issue" | "regression" } | { type: "threshold"; count: number };

export interface IntegrationRule {
  id: string;
  type: string;
  trigger: Trigger;
  projects?: string[];
  levels?: string[];
  includeStacktrace?: boolean;
  options: Record<string, unknown>;
  // A configuration change must not send an old job to a different destination.
  revision: string;
}

export interface Notification {
  kind: Trigger["type"];
  issue: Issue;
  event_id?: string;
  stacktrace?: string;
}

export interface DeliveryContext {
  signal: AbortSignal;
  idempotencyKey: string;
}

/** Factories validate options and resolve secrets once, before the server starts. */
export interface IntegrationPlugin {
  create(options: Record<string, unknown>, env: Record<string, string | undefined>): {
    send(notification: Notification, context: DeliveryContext): Promise<void>;
  };
}

export type Delivery = ReturnType<IntegrationPlugin["create"]>;

/** Custom plugins may use this to classify permanent failures or a provider retry delay. */
export class DeliveryError extends Error {
  constructor(public readonly retryable: boolean, public readonly retryAfterMs?: number, public readonly httpStatus?: number) {
    super("Integration delivery failed");
  }
}
