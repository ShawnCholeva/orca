import { isTauri } from "@tauri-apps/api/core";

export async function expandTilde(inputPath: string): Promise<string> {
  if (!inputPath.startsWith("~")) return inputPath;
  if (!isTauri()) return inputPath;
  try {
    const { homeDir } = await import("@tauri-apps/api/path");
    const home = await homeDir();
    return inputPath === "~" ? home : `${home}${inputPath.slice(1)}`;
  } catch {
    return inputPath;
  }
}
