import { isTauri } from "@tauri-apps/api/core";
import type { RunSummary } from "@orca/contracts";

// A2, part 2: the case where the reader is AT the machine with Orca behind
// another window. Part 1 (the WAITING chip on the goals rail) covers the closed
// lid, because nothing can fire while the daemon is asleep; this covers the open
// lid, once, at the moment a run first parks — and only when the app cannot be
// seen. A notification over a visible Orca is noise; the chip already says it.

type Waiting = Map<string, RunSummary["awaitingYou"]>;

/** Goals that are waiting now and were not waiting before. */
export function newlyWaiting(prev: Waiting, next: Waiting): string[] {
  return [...next.keys()].filter((goalId) => !prev.has(goalId));
}

/** True when the reader cannot see the app: hidden, or open behind another window. */
export function appOutOfSight(doc: Document = document): boolean {
  return doc.visibilityState !== "visible" || !doc.hasFocus();
}

/**
 * One OS notification. Under Tauri the webview has no Notification API, so the
 * notification plugin carries it; in a browser the Web API does. Permission is
 * asked the first time something is worth saying, never on boot — a permission
 * prompt with nothing behind it is the fastest way to get it denied.
 */
export async function notifyParked(title: string, body: string): Promise<void> {
  if (isTauri()) {
    const { isPermissionGranted, requestPermission, sendNotification } = await import("@tauri-apps/plugin-notification");
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    if (granted) sendNotification({ title, body });
    return;
  }
  if (typeof Notification === "undefined") return;
  if (Notification.permission === "default") await Notification.requestPermission();
  if (Notification.permission === "granted") new Notification(title, { body });
}
