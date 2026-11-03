"use client";
import * as Sentry from "@sentry/nextjs";
export default function Page() {
  return <button id="capture" onClick={async () => {
    const id = Sentry.captureException(new Error("nextjs-browser-proof"));
    await Sentry.flush(5000);
    document.getElementById("capture").dataset.event = id;
  }}>Capture test error</button>;
}
