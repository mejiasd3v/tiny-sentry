import * as Sentry from "@sentry/nextjs";
export const runtime = "edge";
export const dynamic = "force-dynamic";
export async function GET() {
  const id = Sentry.captureException(new Error("nextjs-edge-proof"));
  await Sentry.flush(5000);
  return Response.json({ id });
}
