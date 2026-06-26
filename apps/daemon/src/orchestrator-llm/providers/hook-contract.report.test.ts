import { describe, it, expect } from "vitest";
import { checkHookContracts } from "./hook-contract.js";

describe("checkHookContracts", () => {
  it("codex worker PermissionRequest is ok when installed minor/major matches verified", () => {
    const { contracts } = checkHookContracts({ versions: { codex: "0.136.4" } });
    const e = contracts.find((c) => c.provider === "codex" && c.event === "PermissionRequest");
    expect(e!.status).toBe("ok"); // patch differs, minor/major same → ignored
    expect(e!.installedVersion).toBe("0.136.4");
  });

  it("codex degrades when installed minor moves off verified", () => {
    const { contracts } = checkHookContracts({ versions: { codex: "0.140.0" } });
    const e = contracts.find((c) => c.provider === "codex" && c.event === "PermissionRequest");
    expect(e!.status).toBe("degraded");
    expect(e!.detail).toMatch(/re-verify/i);
  });

  it("reports unknown when no installed version is available", () => {
    const { contracts } = checkHookContracts({ versions: {} });
    const e = contracts.find((c) => c.provider === "codex" && c.event === "PermissionRequest");
    expect(e!.status).toBe("unknown");
  });

  it("antigravity worker permission surface is unverified regardless of version", () => {
    const { contracts } = checkHookContracts({ versions: { antigravity: "1.2.3" } });
    const e = contracts.find((c) => c.provider === "antigravity" && c.surface === "worker");
    expect(e!.status).toBe("unverified");
  });

  it("entries with no pinned verified version stay ok when conformant", () => {
    const { contracts } = checkHookContracts({ versions: { "claude-code": "9.9.9" } });
    const e = contracts.find((c) => c.provider === "claude-code" && c.event === "Stop");
    expect(e!.status).toBe("ok"); // verifiedAgainstVersion is null → drift not assessed
  });
});
