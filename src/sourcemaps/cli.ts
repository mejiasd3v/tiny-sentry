import { runUploader } from "./uploader";

export async function sourceMapsCommand(args: string[], base: URL, init: RequestInit): Promise<unknown> {
  return runUploader(args, { ...process.env, TINY_SENTRY_URL: base.href, TINY_SENTRY_ADMIN_TOKEN: new Headers(init.headers).get("Authorization")?.replace(/^Bearer /, "") });
}
