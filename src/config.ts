export interface Config {
  adminToken: string;
  projects: Record<string, string>;
  dbPath: string;
  port: number;
  retentionDays: number;
  maxEvents: number;
  maxDbMb: number;
  maxRequestBytes: number;
  maxEventBytes: number;
  rateLimitPerMinute: number;
  webhookUrl?: string;
  webhookToken?: string;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  function integer(name: string, fallback: number, max = 1_000_000_000) {
    const value = Number(env[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value < 1 || value > max) {
      throw new Error(`${name} must be an integer between 1 and ${max}`);
    }
    return value;
  }
  const adminToken = env.ADMIN_TOKEN ?? "";
  if (adminToken.length < 32) throw new Error("ADMIN_TOKEN must contain at least 32 characters");
  let raw: unknown;
  try {
    raw = JSON.parse(env.SENTRY_PROJECTS ?? "{}");
  } catch {
    throw new Error('SENTRY_PROJECTS must be a JSON object, e.g. {"1":"public-key"}');
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !Object.keys(raw).length) {
    throw new Error("SENTRY_PROJECTS must contain at least one project");
  }
  const projects: Record<string, string> = Object.create(null);
  for (const [id, key] of Object.entries(raw)) {
    if (!/^[1-9]\d{0,15}$/.test(id) || typeof key !== "string" || !/^[a-zA-Z0-9_-]{16,128}$/.test(key)) {
      throw new Error("Project IDs must be positive integers; public keys must be 16-128 URL-safe characters");
    }
    if (key === adminToken) throw new Error("Public keys must differ from ADMIN_TOKEN");
    projects[id] = key;
  }
  if (env.WEBHOOK_URL && !["http:", "https:"].includes(new URL(env.WEBHOOK_URL).protocol)) {
    throw new Error("WEBHOOK_URL must use HTTP or HTTPS");
  }
  const maxRequestBytes = integer("MAX_REQUEST_BYTES", 1_048_576, 10_485_760);
  const maxEventBytes = integer("MAX_EVENT_BYTES", 131_072, maxRequestBytes);
  return {
    adminToken, projects,
    dbPath: env.DB_PATH || "./data/tiny-sentry.sqlite",
    port: integer("PORT", 3000, 65535),
    retentionDays: integer("RETENTION_DAYS", 14, 3650),
    maxEvents: integer("MAX_EVENTS", 10_000, 1_000_000),
    maxDbMb: integer("MAX_DB_MB", 256, 16_384),
    maxRequestBytes, maxEventBytes,
    rateLimitPerMinute: integer("RATE_LIMIT_PER_MINUTE", 120, 1_000_000),
    webhookUrl: env.WEBHOOK_URL || undefined,
    webhookToken: env.WEBHOOK_TOKEN || undefined,
  };
}
