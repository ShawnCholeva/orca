import { describe, expect, it } from "vitest";

import { ensureNodePtySpawnHelperExecutable } from "./manager.js";

describe("ensureNodePtySpawnHelperExecutable", () => {
  it("adds execute bits to node-pty's macOS spawn helper when pnpm installs it non-executable", () => {
    let mode = 0o100644;
    const chmodCalls: Array<{ filePath: string; nextMode: number }> = [];

    ensureNodePtySpawnHelperExecutable({
      platform: "darwin",
      resolveSpawnHelperPath: () => "/repo/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper",
      statSync: () => ({ mode }),
      chmodSync: (filePath, nextMode) => {
        chmodCalls.push({ filePath, nextMode });
        mode = nextMode;
      },
    });

    expect(chmodCalls).toEqual([
      {
        filePath: "/repo/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper",
        nextMode: 0o100755,
      },
    ]);
  });
});
