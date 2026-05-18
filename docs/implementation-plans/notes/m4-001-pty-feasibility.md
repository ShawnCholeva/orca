# M4-001 — Native PTY Feasibility and Sidecar Spike

Anchored on M4-000 baseline SHA `279d435af82a55e08544a6f46cce473c7c3426de`.

## Decision

**GO** — proceed to M4-002.

`node-pty` installs, imports, and spawns a working PTY on the primary local
target (linux-x64). The existing sidecar build flow can locate the package in
the pnpm store the same way it already locates `better-sqlite3`, `bindings`,
and `file-uri-to-path`. The list of files required for packaging is small
and well-bounded. The Tauri spawn path is unchanged.

## Version

- Declared in `apps/daemon/package.json` as `node-pty ^1.0.0`.
- Resolved to `node-pty@1.1.0` (latest published 1.x at the time of the spike).
- Transitive (build-time only): `node-addon-api@7.1.1` — header-only, compiled
  into `pty.node`. Not needed in the sidecar runtime tree.

## Verified Local Target

| Field | Value |
|---|---|
| Triple (build-sidecar.mjs) | `x86_64-unknown-linux-gnu` |
| Platform / arch | linux / x64 |
| Node | v25.2.1 |
| Result | spike printed `orca-pty-ok`, exit 0, signal 0 |

`pnpm --filter @orca/daemon install` succeeded; node-gyp built `pty.node` from
source against the local Node. `node apps/daemon/scripts/m4-001-pty-spike.mjs`
prints the sentinel and exits 0.

## Native Artifact Layout (in pnpm store)

Package root:
`node_modules/.pnpm/node-pty@1.1.0/node_modules/node-pty/`

What ships from npm (per `files` in node-pty's `package.json`):
`binding.gyp`, `lib/`, `scripts/`, `src/`, `deps/`, `prebuilds/`,
`third_party/`, `typings/`.

What is required at runtime per platform:

- **linux-x64 / linux-arm64** — no prebuilt binary is shipped. `node-gyp`
  builds from source at install time, producing `build/Release/pty.node`.
  Runtime needs only:
  - `lib/**/*.js` (loader and JS wrappers)
  - `build/Release/pty.node` (native addon, ABI-matched to the embedded Node)
  - `package.json`
- **darwin-arm64** — shipped prebuilt. Runtime needs:
  - `lib/**/*.js`
  - `prebuilds/darwin-arm64/pty.node`
  - `prebuilds/darwin-arm64/spawn-helper` (small executable invoked by the
    native binding on macOS; absent on Linux because forkpty is used directly)
  - `package.json`
- **darwin-x64** — same shape as darwin-arm64 with the matching prebuild dir.
- **win32-** — out of scope for M4 (best-effort).

The loader (`lib/utils.js → loadNativeModule`) probes, in order, relative to
`lib/`:
1. `../build/Release/pty.node`
2. `./build/Release/pty.node`
3. `../build/Debug/pty.node`
4. `./build/Debug/pty.node`
5. `../prebuilds/<platform>-<arch>/pty.node`
6. `./prebuilds/<platform>-<arch>/pty.node`

So either an unbundled npm-style layout (`node_modules/node-pty/...`) or a
flattened bundled layout works. The sidecar currently uses the unbundled
layout under `dist/sidecar/runtime/node_modules/`, which matches probe (1)/(5).

## Rebuild Requirements

- On linux-x64 / linux-arm64 the ABI is decided at install time. The
  `build/Release/pty.node` produced during `pnpm install` must match the Node
  version embedded in the SEA binary. The current build script copies
  `process.execPath` into the SEA, so the Node that runs the build is the Node
  that ships — same Node also drives the install, so ABI is consistent on this
  spike. If a packaging step ever runs install on one Node and SEA injection on
  another, that would need to be resynchronized.
- On darwin-arm64 / darwin-x64 the prebuild ships, so no node-gyp toolchain is
  required at install time on those targets — provided the Node version is
  compatible with the prebuild's NAPI version (node-pty 1.1.0 uses NAPI which
  is ABI-stable across modern Node majors, so this is normally a non-issue).
- No additional system libraries are required at runtime on linux beyond the
  glibc baseline already required by node-pty (verified by a successful spawn).

## Sidecar Dry-Run

`pnpm --filter @orca/daemon build:sidecar` was run **unmodified** against
the current code (the M4-001 spike adds `node-pty` to `dependencies` but does
not yet wire it into the daemon or the build script). It produced
`apps/daemon/dist/sidecar/orca-daemon-x86_64-unknown-linux-gnu` (~120 MB) and
the runtime tree at `apps/daemon/dist/sidecar/runtime/node_modules/` containing
only `better-sqlite3`, `bindings`, and `file-uri-to-path` — i.e. node-pty is
**not** yet in the bundled sidecar. That is expected: M4-001 is a discovery
task and the production build-script change is M4-015.

Simulating the cpSync copy with the existing `skipDirs` filter
(`["node_modules", "src", "deps", "test", "obj", "obj.target"]`) against the
node-pty package root yields 84 files, ~63 MB. Most of the weight is from
`third_party/conpty/...` and `prebuilds/win32-*`. Future trimming for linux-
only or darwin-only sidecars is straightforward; for M4 the default filter is
acceptable.

## Files M4-015 Will Need to Copy

When `build-sidecar.mjs` is extended (M4-015 task — **not** in M4-001),
adding `"node-pty"` to the list iterated alongside `better-sqlite3`,
`bindings`, `file-uri-to-path` will:

- Resolve the package via `findPkg("node-pty")` (matches
  `node-pty@*` in `node_modules/.pnpm`).
- `cpSync` copies, after the existing `skipDirs` filter, the tree listed under
  "Native artifact layout" above.
- The `nativeRuntimeShim` esbuild plugin's `externals` set must also gain
  `"node-pty"` so that `require('node-pty')` in production daemon code is
  routed through `ORCA_RUNTIME_DIR` instead of bundled inline.

No other changes to `build-sidecar.mjs` are anticipated for node-pty support.

## Open Items (Not M4-001)

- **M4-005** must own the production import of `node-pty`. The ONLY production
  file allowed to `require('node-pty')` is `apps/daemon/src/pty/manager.ts`,
  per the M4 architectural constraints.
- **M4-015** owns the actual edit to `build-sidecar.mjs` and the bundled
  smoke test (Gate 6).
- **Windows** is best-effort for M4. The prebuilds dir already ships the
  required artifacts, but conpty integration is out of scope for the M4
  proof-point.

## Spike Script

`apps/daemon/scripts/m4-001-pty-spike.mjs` is a scratch script. It may be
deleted at the end of M4; this note is the durable artifact.
