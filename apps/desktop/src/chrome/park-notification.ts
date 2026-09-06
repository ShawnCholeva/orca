import { isTauri } from "@tauri-apps/api/core";
import type { RunSummary } from "@orca/contracts";

// A2, part 2: the case where the reader is AT the machine with Orca behind
// another window. Part 1 (the WAITING chip on the goals rail) covers the closed
// lid, because nothing can fire while the daemon is asleep; this covers the open
// lid, once, at the moment a run first parks — and only when the app cannot be
// seen. A notification over a visible Orca is noise; the chip already says it.

type Waiting = Map<string, RunSummary["awaitingYou"]>;

/**
 * Goals with something new to say: waiting now and not before, or waiting for a
 * DIFFERENT thing than before. A reader who answered the confirmation card and
 * walked away would otherwise never hear about the mark-done card that followed
 * it thirty seconds later, because the goal never stopped "waiting".
 */
export function newlyWaiting(prev: Waiting, next: Waiting): string[] {
  return [...next.entries()]
    .filter(([goalId, w]) => {
      const before = prev.get(goalId);
      return before === undefined || before.sourceKind !== w.sourceKind;
    })
    .map(([goalId]) => goalId);
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
