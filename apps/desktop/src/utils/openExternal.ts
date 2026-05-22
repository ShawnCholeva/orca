import { openUrl } from "@tauri-apps/plugin-opener";

export function openExternal(url: string): void {
  void openUrl(url);
}
