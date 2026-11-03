import * as Sentry from "@sentry/nextjs";
export const dynamic = "force-dynamic";
export async function GET() {
  const id = Sentry.captureException(new Error("nextjs-server-proof"));
  await Sentry.flush(5000);
  return Response.json({ id });
}
