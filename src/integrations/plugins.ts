import { createHmac } from "node:crypto";
import { object } from "../protocol";
import { DeliveryError, type DeliveryContext, type IntegrationPlugin, type Notification } from "./types";

function options(raw: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(raw).some((key) => !allowed.includes(key))) throw new Error("Unknown integration option");
  return {
    text(name: string) {
      const value = raw[name];
      if (typeof value !== "string" || !value || value.length > 2048 || /[\r\n]/.test(value)) throw new Error("Invalid integration option");
      return value;
    },
    secret(name: string, env: Record<string, string | undefined>) {
      const key = raw[name];
      if (typeof key !== "string" || !/^[A-Z_][A-Z0-9_]*$/.test(key)) throw new Error("Expected a secret environment variable name");
      const value = env[key];
      if (!value || /[\r\n]/.test(value)) throw new Error("Missing or invalid integration secret");
      return value;
    },
  };
}

function httpUrl(value: string) {
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.hash) throw new Error("Invalid integration URL");
  return url;
}

function retryAfter(response: Response) {
  const value = response.headers.get("retry-after");
  if (!value) {
    const reset = Number(response.headers.get("x-ratelimit-reset"));
    return response.headers.get("x-ratelimit-remaining") === "0" && reset > 0
      ? Math.min(86_400_000, Math.max(1000, reset * 1000 - Date.now())) : undefined;
  }
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) ? Math.min(86_400_000, Math.max(1000, ms)) : undefined;
}

async function post(url: string | URL, body: unknown, headers: Record<string, string>, context: DeliveryContext, json = false): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST", headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body), signal: context.signal, redirect: "error",
  });
  if (!response.ok) {
    let delay = retryAfter(response);
    if (json && response.status === 429) {
      let result: unknown;
      try { result = await responseJson(response); }
      catch { throw new DeliveryError(true, delay, response.status); }
      if (object(result) && object(result.parameters) && typeof result.parameters.retry_after === "number") {
        delay = Math.min(86_400_000, Math.max(1000, result.parameters.retry_after * 1000));
      }
    } else await response.body?.cancel();
    throw new DeliveryError([408, 425, 429].includes(response.status) || response.status >= 500 || (response.status === 403 && delay !== undefined), delay, response.status);
  }
  if (!json) { await response.body?.cancel(); return; }
  return responseJson(response);
}

async function responseJson(response: Response): Promise<unknown> {
  // Only GraphQL/Telegram require response JSON. Bound it even for a broken endpoint.
  const reader = response.body?.getReader();
  if (!reader) throw new DeliveryError(true);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 32_768) throw new DeliveryError(false);
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString()) as unknown;
  } finally { await reader.cancel(); }
}

function summary({ kind, issue }: Notification) {
  return `tiny-sentry: ${kind}\n${issue.title}\nProject ${issue.project_id} · issue #${issue.id} · ${issue.level}\nOccurrences: ${issue.event_count}\nFingerprint: ${issue.fingerprint}`;
}

function markdown(notification: Notification) {
  return `Reported by tiny-sentry.\n\n\`\`\`text\n${summary(notification).replaceAll("`", "'")}\n\`\`\``;
}

export const builtinPlugins: Record<string, IntegrationPlugin> = {
  webhook: {
    create(raw, env) {
      const opts = options(raw, ["url", "urlEnv", "tokenEnv", "signingSecretEnv"]);
      if ((raw.url !== undefined) === (raw.urlEnv !== undefined)) throw new Error("Set exactly one webhook URL option");
      const url = httpUrl(raw.urlEnv !== undefined ? opts.secret("urlEnv", env) : opts.text("url"));
      const token = raw.tokenEnv !== undefined ? opts.secret("tokenEnv", env) : undefined;
      const signingSecret = raw.signingSecretEnv !== undefined ? opts.secret("signingSecretEnv", env) : undefined;
      return { async send(notification, context) {
        const headers: Record<string, string> = { "idempotency-key": context.idempotencyKey };
        if (token) headers.authorization = `Bearer ${token}`;
        if (signingSecret) {
          const timestamp = Math.floor(Date.now() / 1000);
          const signature = createHmac("sha256", signingSecret).update(`${timestamp}.${JSON.stringify(notification)}`).digest("hex");
          headers["x-tiny-sentry-signature"] = `t=${timestamp},v1=${signature}`;
        }
        await post(url, notification, headers, context);
      } };
    },
  },
  github: {
    create(raw, env) {
      const opts = options(raw, ["repository", "tokenEnv"]);
      const repository = opts.text("repository");
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("Invalid GitHub repository");
      const token = opts.secret("tokenEnv", env);
      return { async send(notification, context) {
        await post(`https://api.github.com/repos/${repository}/issues`, {
          title: notification.issue.title.slice(0, 240), body: markdown(notification),
        }, { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "tiny-sentry" }, context);
      } };
    },
  },
  linear: {
    create(raw, env) {
      const opts = options(raw, ["teamId", "tokenEnv"]);
      const teamId = opts.text("teamId");
      const token = opts.secret("tokenEnv", env);
      return { async send(notification, context) {
        const result = await post("https://api.linear.app/graphql", {
          query: "mutation TinySentryIssue($input: IssueCreateInput!) { issueCreate(input: $input) { success } }",
          variables: { input: { teamId, title: notification.issue.title.slice(0, 240), description: markdown(notification) } },
        }, { authorization: token }, context, true);
        if (object(result) && object(result.data) && object(result.data.issueCreate) && result.data.issueCreate.success === true && !result.errors) return;
        const rateLimited = object(result) && Array.isArray(result.errors) && result.errors.some((error) =>
          object(error) && object(error.extensions) && error.extensions.code === "RATELIMITED");
        throw new DeliveryError(Boolean(rateLimited), rateLimited ? 60_000 : undefined);
      } };
    },
  },
  jira: {
    create(raw, env) {
      const opts = options(raw, ["baseUrl", "projectKey", "issueTypeId", "emailEnv", "tokenEnv"]);
      const base = httpUrl(opts.text("baseUrl"));
      if (base.protocol !== "https:" || base.pathname !== "/" || base.search) throw new Error("Jira baseUrl must be an HTTPS origin");
      const projectKey = opts.text("projectKey");
      const issueTypeId = opts.text("issueTypeId");
      const authorization = `Basic ${Buffer.from(`${opts.secret("emailEnv", env)}:${opts.secret("tokenEnv", env)}`).toString("base64")}`;
      return { async send(notification, context) {
        await post(new URL("/rest/api/3/issue", base), { fields: {
          project: { key: projectKey }, issuetype: { id: issueTypeId }, summary: notification.issue.title.slice(0, 240),
          description: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: summary(notification) }] }] },
        } }, { authorization }, context);
      } };
    },
  },
  telegram: {
    create(raw, env) {
      const opts = options(raw, ["tokenEnv", "chatId"]);
      const token = opts.secret("tokenEnv", env);
      if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new Error("Invalid Telegram bot token");
      const chatId = opts.text("chatId");
      return { async send(notification, context) {
        const result = await post(`https://api.telegram.org/bot${token}/sendMessage`, {
          chat_id: chatId, text: summary(notification), link_preview_options: { is_disabled: true },
        }, {}, context, true);
        if (object(result) && result.ok === true) return;
        const delay = object(result) && object(result.parameters) && typeof result.parameters.retry_after === "number"
          ? Math.min(86_400_000, Math.max(1000, result.parameters.retry_after * 1000)) : undefined;
        throw new DeliveryError(Boolean(delay) || (object(result) && typeof result.error_code === "number" && result.error_code >= 500), delay);
      } };
    },
  },
  discord: {
    create(raw, env) {
      const opts = options(raw, ["urlEnv"]);
      const url = httpUrl(opts.secret("urlEnv", env));
      if (url.protocol !== "https:" || url.hostname !== "discord.com" || !/^\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+$/.test(url.pathname)) throw new Error("Invalid Discord webhook URL");
      url.searchParams.set("wait", "true");
      return { async send(notification, context) {
        await post(url, { content: summary(notification), allowed_mentions: { parse: [] } }, {}, context);
      } };
    },
  },
};
