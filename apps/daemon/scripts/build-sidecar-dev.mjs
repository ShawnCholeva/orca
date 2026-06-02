#!/usr/bin/env node
// Creates placeholder files so that tauri_build::build() can find the
// externalBin and resources paths during `tauri dev`. In debug builds,
// lib.rs always uses spawn_dev() (tsx watch) and never launches this stub,
// so the placeholder just needs to exist — it is never executed.

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");

const arch = { x64: "x86_64", arm64: "aarch64" }[process.arch];
if (!arch) throw new Error(`Unsupported arch: ${process.arch}`);
const platformPart = {
  linux: "unknown-linux-gnu",
  darwin: "apple-darwin",
  win32: "pc-windows-msvc",
}[process.platform];
if (!platformPart) throw new Error(`Unsupported platform: ${process.platform}`);
const triple = `${arch}-${platformPart}`;
const exeSuffix = process.platform === "win32" ? ".exe" : "";

const sidecarDir = path.join(pkgRoot, "dist", "sidecar");
const binaryPath = path.join(sidecarDir, `orca-daemon-${triple}${exeSuffix}`);
const runtimeDir = path.join(sidecarDir, "runtime");

mkdirSync(sidecarDir, { recursive: true });
mkdirSync(runtimeDir, { recursive: true });

writeFileSync(binaryPath, "# dev stub — not invoked in debug builds\n");
if (process.platform !== "win32") {
  chmodSync(binaryPath, 0o755);
}

console.log(`[sidecar-dev] stub: ${binaryPath}`);
console.log(`[sidecar-dev] runtime dir: ${runtimeDir}`);
