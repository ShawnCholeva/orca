#!/usr/bin/env node
// Builds the daemon as a Node SEA binary + runtime tree. See README
// "Production bundle (sidecar)" for layout and caveats.

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");
const repoRoot = path.resolve(pkgRoot, "..", "..");

const triple = computeTargetTriple();
const isWindows = process.platform === "win32";
const exeSuffix = isWindows ? ".exe" : "";

const sidecarDir = path.join(pkgRoot, "dist", "sidecar");
const buildDir = path.join(pkgRoot, "dist", "sidecar-build");
const bundlePath = path.join(buildDir, "bundle.cjs");
const seaConfigPath = path.join(buildDir, "sea-config.json");
const seaBlobPath = path.join(buildDir, "sea.blob");
const runtimeNodeModules = path.join(sidecarDir, "runtime", "node_modules");
const binaryPath = path.join(
  sidecarDir,
  `orca-daemon-${triple}${exeSuffix}`
);

function computeTargetTriple() {
  const arch = { x64: "x86_64", arm64: "aarch64" }[process.arch];
  if (!arch) throw new Error(`Unsupported arch: ${process.arch}`);
  const platformPart = {
    linux: "unknown-linux-gnu",
    darwin: "apple-darwin",
    win32: "pc-windows-msvc",
  }[process.platform];
  if (!platformPart) {
    throw new Error(`Unsupported platform: ${process.platform}`);
  }
  return `${arch}-${platformPart}`;
}

function listMigrations() {
  const dir = path.join(pkgRoot, "migrations");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((name) => ({
      key: `migrations/${name}`,
      absPath: path.join(dir, name),
    }));
}

// SEA's embedded require only resolves built-in modules, so route external
// packages through createRequire rooted at ORCA_RUNTIME_DIR.
const nativeRuntimeShim = {
  name: "native-runtime-shim",
  setup(build) {
    const externals = new Set(["better-sqlite3", "bindings"]);
    build.onResolve({ filter: /.*/ }, (args) => {
      if (!externals.has(args.path)) return null;
      return { path: args.path, namespace: "native-runtime-shim" };
    });
    build.onLoad(
      { filter: /.*/, namespace: "native-runtime-shim" },
      (args) => ({
        contents: `
          const { createRequire } = require("node:module");
          const path = require("node:path");
          const runtimeDir = process.env.ORCA_RUNTIME_DIR;
          if (!runtimeDir) {
            throw new Error("ORCA_RUNTIME_DIR not set; sidecar cannot load ${args.path}");
          }
          const req = createRequire(path.join(runtimeDir, "noop.js"));
          module.exports = req(${JSON.stringify(args.path)});
        `,
        loader: "js",
      })
    );
  },
};

async function bundleDaemon() {
  await esbuild({
    entryPoints: [path.join(pkgRoot, "src", "index.ts")],
    outfile: bundlePath,
    bundle: true,
    platform: "node",
    target: "node20",
    format: "cjs",
    sourcemap: false,
    legalComments: "none",
    plugins: [nativeRuntimeShim],
    // import.meta.url is empty in CJS; route it through __filename so any
    // non-sidecar code path that evaluates it (e.g. defaultMigrationsDir)
    // gets a syntactically valid file URL instead of crashing.
    define: {
      "import.meta.url": "__bundleFileUrl",
    },
    banner: {
      js: `"use strict";\nvar __bundleFileUrl = require('node:url').pathToFileURL(__filename).href;`,
    },
    logLevel: "info",
  });
}

function copyRuntimeTree() {
  rmSync(path.join(sidecarDir, "runtime"), { recursive: true, force: true });
  mkdirSync(runtimeNodeModules, { recursive: true });

  const pnpmStore = path.join(repoRoot, "node_modules", ".pnpm");
  const storeEntries = readdirSync(pnpmStore);
  const findPkg = (name) => {
    const matches = storeEntries.filter((d) => d.startsWith(`${name}@`)).sort();
    if (matches.length === 0) {
      throw new Error(`Could not locate ${name} in ${pnpmStore}`);
    }
    return path.join(pnpmStore, matches[matches.length - 1], "node_modules", name);
  };

  const skipDirs = new Set(["node_modules", "src", "deps", "test", "obj", "obj.target"]);
  for (const name of ["better-sqlite3", "bindings", "file-uri-to-path"]) {
    const src = findPkg(name);
    const dst = path.join(runtimeNodeModules, name);
    cpSync(src, dst, {
      recursive: true,
      dereference: true,
      filter: (entry) => {
        const segments = path.relative(src, entry).split(path.sep);
        return !segments.some((seg) => skipDirs.has(seg));
      },
    });
  }
}

function writeSeaConfig(migrations) {
  const assets = Object.fromEntries(
    migrations.map((m) => [m.key, m.absPath])
  );
  const config = {
    main: bundlePath,
    output: seaBlobPath,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
    assets,
  };
  writeFileSync(seaConfigPath, JSON.stringify(config, null, 2));
}

function generateSeaBlob() {
  const result = spawnSync(
    process.execPath,
    ["--experimental-sea-config", seaConfigPath],
    { stdio: "inherit" }
  );
  if (result.status !== 0) {
    throw new Error(`SEA blob generation failed (exit ${result.status})`);
  }
  if (!existsSync(seaBlobPath)) {
    throw new Error(`SEA blob not produced at ${seaBlobPath}`);
  }
}

function makeBinary() {
  cpSync(process.execPath, binaryPath);
  chmodSync(binaryPath, 0o755);

  const sentinel = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
  const args = [
    "postject",
    binaryPath,
    "NODE_SEA_BLOB",
    seaBlobPath,
    "--sentinel-fuse",
    sentinel,
  ];
  if (process.platform === "darwin") {
    args.push("--macho-segment-name", "NODE_SEA");
  }
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  const result = spawnSync(npx, args, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`postject injection failed (exit ${result.status})`);
  }
}

async function main() {
  rmSync(sidecarDir, { recursive: true, force: true });
  rmSync(buildDir, { recursive: true, force: true });
  mkdirSync(sidecarDir, { recursive: true });
  mkdirSync(buildDir, { recursive: true });

  console.log(`[sidecar] target triple: ${triple}`);
  console.log("[sidecar] bundling daemon with esbuild...");
  await bundleDaemon();

  console.log("[sidecar] copying runtime tree (better-sqlite3 + bindings)...");
  copyRuntimeTree();

  console.log("[sidecar] writing SEA config...");
  const migrations = listMigrations();
  writeSeaConfig(migrations);

  console.log("[sidecar] generating SEA blob...");
  generateSeaBlob();

  console.log("[sidecar] injecting blob into Node binary...");
  makeBinary();

  const sizeMb = (statSync(binaryPath).size / 1024 / 1024).toFixed(1);
  console.log(`[sidecar] done: ${binaryPath} (${sizeMb} MB)`);
  console.log(`[sidecar] runtime: ${runtimeNodeModules}`);
}

main().catch((err) => {
  console.error("[sidecar] build failed:", err);
  process.exit(1);
});
