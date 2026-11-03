# Next.js private source maps

Use the official single-file [Node uploader](../tools/upload-sourcemaps.mjs) after a Next build. Consuming apps need Node, their existing Sentry SDK, and that file. They do not need Bun, a tiny-sentry checkout, an upload plugin, or additional dependencies.

Verified with Node **22.23.2**, Next.js **16.3.0 Turbopack**, and **@sentry/nextjs 11.10.0**, including real browser, Node server, and edge events. Use Node 22.12+ for this SDK version. Other Next/SDK versions and webpack builds need their own verification.

## Collector

Upgrade tiny-sentry to a commit containing this helper and indexed-map support; `ba64b7d` predates both. The database remains schema v4. Enable `SOURCEMAPS_ENABLED=true`. No extra service or database is needed.

Defaults stay at 8 MiB per upload, 16 MiB accounted decoded memory, 64 MiB compressed storage, 1,000 artifacts, and 10,000 release aliases **across all projects**. These are deliberate limits, not promises that every Next build fits. Our real SDK fixture needs `SOURCEMAPS_CACHE_MB=32` for a mixed application/SDK chunk. A read-only production build also contained an application map exceeding the default 16 MiB. Inspect preflight before adjusting limits; raising this budget can raise process RSS. See [all resource limits](sourcemaps.md#resource-and-compatibility-limits).

## Build and runtime configuration

Set one immutable identity **before building**, such as `NEXT_PUBLIC_SENTRY_RELEASE=web@<commit-sha>`. Use the same value for browser, server, edge, and uploader. Do not change it when starting the built image. Distinct builds of one commit need distinct identities if their output differs. For multiple services, include the service name and use each service's DSN project.

In `next.config.mjs`, merge the following into your existing configuration. The `/config` import is required by SDK 11.10.0:

```js
import { withSentryConfig } from "@sentry/nextjs/config";

const release = process.env.NEXT_PUBLIC_SENTRY_RELEASE;
if (!release) throw new Error("Set an immutable NEXT_PUBLIC_SENTRY_RELEASE before building");

export default withSentryConfig({
  output: "standalone", // optional; the uploader also handles its public map copies
  productionBrowserSourceMaps: true,
  experimental: { serverSourceMaps: true },
  turbopack: { debugIds: true },
  env: {
    NEXT_PUBLIC_SENTRY_RELEASE: release,
    NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
  },
}, {
  sourcemaps: { disable: true, deleteSourcemapsAfterUpload: false },
  release: { name: release, create: false, finalize: false },
  telemetry: false,
  silent: true,
});
```

Sentry's artifact uploads and release APIs are incompatible with tiny-sentry. Keep its upload and deletion disabled. Explicit `turbopack.debugIds: true` is needed because disabling Sentry's uploader also disables its automatic Debug ID configuration in this version. tiny-sentry reads existing IDs; it never injects IDs or rewrites generated JS.

In each existing `instrumentation-client.ts`, `sentry.server.config.ts`, and `sentry.edge.config.ts`, initialize with:

```ts
import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  release: process.env.NEXT_PUBLIC_SENTRY_RELEASE,
  tracesSampleRate: 0,
  sendDefaultPii: false,
});
```

Keep your normal Next instrumentation hooks that load the server/edge configs and call `captureRequestError`. The [executable fixture](../test/fixtures/nextjs) shows a complete minimal setup. Only public DSN and release values belong in `NEXT_PUBLIC_*` or `next.config.env`. **Never put the admin token there**, in SDK options, or in application code.

## Upload from Node, pnpm, Docker, or Nixpacks

Download the helper once from a reviewed **full commit SHA** and keep it in your application's build tooling, or download that pinned revision in CI. It is a standalone Node ESM file, with no installation step:

```sh
# Substitute the reviewed tiny-sentry commit, not a moving branch.
TINY_SENTRY_COMMIT=<full-reviewed-commit-sha>
curl --fail --location \
  "https://raw.githubusercontent.com/mejiasd3v/tiny-sentry/$TINY_SENTRY_COMMIT/tools/upload-sourcemaps.mjs" \
  --output upload-sourcemaps.mjs
```

Run the following **after** the build, or after restoring its complete cached output, and **before** publishing the image/assets:

```sh
# Public build settings, supplied before pnpm build / turbo run build:
# NEXT_PUBLIC_SENTRY_RELEASE=web@<immutable-build-id>
# NEXT_PUBLIC_SENTRY_DSN=https://<public-key>@<collector-host>/1

# Supply these in the uploader's private environment:
# TINY_SENTRY_URL=https://<collector-host>
# TINY_SENTRY_ADMIN_TOKEN=<secret from CI/build-secret store>
# TINY_SENTRY_PROJECT=1

node upload-sourcemaps.mjs next apps/web/.next --dry-run
node upload-sourcemaps.mjs next apps/web/.next --delete-public-maps
```

For a single app use `.next` as the path. `--project 1` and `--release "$NEXT_PUBLIC_SENTRY_RELEASE"` can replace the corresponding environment defaults. Use the service's project from its DSN. If `SENTRY_DSN` or `NEXT_PUBLIC_SENTRY_DSN` is present, the helper rejects a mismatched project or collector origin. Set `TINY_SENTRY_URL` to the public collector origin for this check.

The token is an instance-wide admin credential. Supply it only to the upload process through CI secrets or an ephemeral build-secret mount; do not put it in Docker `ARG`/`ENV`, generated bundles, cache keys, logs, or the final runtime image. A separate upload job before the image publish step is also supported. The helper never prints the token. Build/deploy must fail if upload or cleanup fails.

**Turborepo:** run the upload command outside the cached build task, every deployment, even when `turbo run build` hits cache. Include the public release and DSN in the build task's declared environment so they participate in cache identity. Cache the complete, unpruned `.next` output, then upload and clean the restored working copy. Do not cache upload success or the cleaned output as a substitute for executing the uploader. This also refreshes map retention on redeployment. Run only the appropriate Next app uploader for each service; unrelated worker/job services do not need it.

For standalone deployments, copy static assets into their final `.next/standalone/**/.next/static` location before cleanup, or copy from the already cleaned primary static tree afterward. On success, the helper removes **all** `.map` files under the primary static tree and recognized standalone static copies, including skipped vendor and CSS maps. Server maps remain private. It verifies map hashes before deletion and never changes generated JS bytes. No public maps are deleted if preflight or any upload fails. Deploy only after a zero exit status, since filesystem cleanup itself can fail partway through.

The helper requires browser maps to be present and reports an error for an already pruned build. Restore the unpruned cached build rather than silently skipping upload. Custom `distDir` names work when passed as the directory; standalone copies must use that same directory name. Symlinked artifact trees are rejected; dependency directories are skipped. If you copy maps to a separate CDN staging directory outside these trees, clean that copy before publication too.

## Selection, diagnostics, and retention

`next` defaults to `--selection app`. It keeps an entire JavaScript map if any source appears to be application code. It skips maps containing only `node_modules`, Next/Turbopack internals, webpack bootstrap/runtime, synthetic sources, or no sources. Mixed application/vendor maps are kept whole, including their vendor source content; there is no lossy flattening or source stripping. CSS maps are not uploaded.

This is a source-path heuristic. Vendor-only errors and excluded runtime chunks will not map. Unusual application source naming may require `--selection all`; inspect the plan's file list and skipped counts. Selected maps that exceed a limit block the build instead of being silently dropped. There is no automatic deletion of unexpired releases to make a build pass.

`--dry-run` emits JSON with selected upload bindings (`selected`), unique map files (`selected_maps`), indexed/ID counts, raw and compressed sizes, accounted decoded bytes, missing generated-file counts, global storage usage, projected artifact/alias growth, cleanup counts, and actionable errors. It makes no writes or deletions. A blocked plan exits 2. With URL and credentials it reads live collector limits and inventory; without them it uses explicitly labeled offline defaults. Old collectors are rejected for indexed uploads. Live inventory shows at most 25 recent aliases per artifact, so estimates may overcount older aliases. Concurrent uploads/expiry can also change the result: **preflight is an estimate, not a reservation**.

Uploads are sequential. Transient HTTP responses, including 429, retry with exponential delay and jitter, respecting `Retry-After` seconds or dates. Each request has at most six attempts within 120 seconds, a 30-second maximum wait, and a 30-second fetch timeout. A longer server wait fails visibly. HTTP **409** (immutable identity conflict) and **507** (capacity) fail immediately and preserve public maps. Partial uploads remain stored; retrying identical artifacts is safe. Transport errors stop the command so CI can retry the job.

Keep artifacts long enough for active deployments, rollbacks, and cached browser clients. Retention defaults to 30 days since upload; repeated identical uploads refresh it. Use application selection first, then choose a deliberate retention/storage policy. `SOURCEMAPS_MAX_ARTIFACTS` and `SOURCEMAPS_MAX_RELEASE_ALIASES` can raise the defaults, up to 100,000 and 1,000,000 respectively. Compressed storage and `MAX_DB_MB` still apply. Raising counts alone cannot solve a byte or decoded-memory limit. Leave database/volume headroom for events and deliveries. The uploader also supports `list` and `delete <artifact-UUID> --project ...`; deletion removes every alias of that artifact, so review rollback/client needs first.

## Matching and verification

| Runtime | Uploaded name | Verified matching |
| --- | --- | --- |
| Browser | `~/_next/static/...js` | Native Turbopack Debug IDs in actual SDK `debug_meta`; release fallback for HTTP(S) URLs and SDK-rewritten `app:///_next/static/...` |
| Server | `app:///_next/server/...js` | Native Debug IDs and release fallback after SDK `DistDirRewriteFrames` rewrites the build directory |
| Edge | `app:///_next/server/...js` | Release/filename fallback; this Next/SDK fixture does **not** emit native edge Debug IDs |

The collector decodes bounded indexed Source Map v3 `sections` directly, preserving nested offsets. Remote section URLs are rejected. Depth is limited to eight, sections to 1,000, and source/name/segment budgets are shared across sections. The helper follows local `sourceMappingURL` references because Turbopack can hash map filenames independently of JS filenames. Native Debug IDs embedded in maps or referenced JS comments are accepted, and conflicting identities fail preflight. Without a reference or paired JS, the plan reports `without_generated_file` and assumes the `.map` suffix convention; verify these aliases for externally collected maps. Maps referenced by several JS files receive each generated filename alias. Identical map content and Debug ID share a blob; distinct IDs remain separate artifacts. Missing Debug IDs use the mandatory shared release. An SDK-advertised ID remains authoritative; missing ID matches never silently fall back to another release map.

To repeat the actual SDK verification from a tiny-sentry checkout, install the isolated fixture dependencies with `npm ci --ignore-scripts` in `test/fixtures/nextjs`, then run `npx playwright install chromium --only-shell` there. With Node 22 on PATH, run `bun run verify:nextjs` at the repo root. CI runs the same proof on Linux. It builds the fixture, uploads through the standalone Node helper, captures real browser/server/edge exceptions, verifies original source context and release matching, and checks that public maps are gone while all generated JS hashes are unchanged. These are local test events; no production collector is used.

Source maps improve exception locations and source context. tiny-sentry still discards transactions/spans; this workflow does not add tracing or alter issue grouping.
