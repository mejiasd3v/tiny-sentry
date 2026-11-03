import type { Store } from "../store";
import type { Notification } from "./types";

/** Resolve only the triggering event; never substitute a newer occurrence. */
export function enrichNotification(store: Store, notification: Notification): Notification {
  if (!store.sourceMaps || !notification.event_id) return notification;
  const saved = store.event(notification.issue.project_id, notification.event_id);
  if (!saved) return notification;
  const mapped = store.sourceMaps.symbolicate(notification.issue.project_id, saved.event).frames
    .filter((frame) => frame.status === "mapped" && frame.path.startsWith("exception."))
    .slice(-8).reverse();
  if (!mapped.length) return notification;
  const text = (value: unknown) => typeof value === "string" ? value.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 160) : "<anonymous>";
  const stacktrace = `Mapped stack (most recent call first):\n${mapped.map(({ original, mapped: location }) =>
    `  at ${text(location!.function ?? original.function)} (${text(location!.filename)}:${location!.lineno}:${location!.colno})`).join("\n")}`.slice(0, 1000);
  return { ...notification, stacktrace };
}
