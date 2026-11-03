import { withSentryConfig } from "@sentry/nextjs/config";

const release = process.env.NEXT_PUBLIC_SENTRY_RELEASE;
if (!release) throw new Error("Set an immutable NEXT_PUBLIC_SENTRY_RELEASE before building");
export default withSentryConfig({
  output: "standalone",
  productionBrowserSourceMaps: true,
  experimental: { serverSourceMaps: true },
  turbopack: { debugIds: true },
  env: { NEXT_PUBLIC_SENTRY_RELEASE: release, NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN },
}, {
  sourcemaps: { disable: true, deleteSourcemapsAfterUpload: false },
  release: { name: release, create: false, finalize: false },
  telemetry: false,
  silent: true,
});
