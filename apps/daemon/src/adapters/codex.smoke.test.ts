import { CodexAdapter } from "./codex.js";
import { describeRealAdapterSmoke } from "./real-smoke.test-support.js";

describeRealAdapterSmoke({
  name: "CodexAdapter",
  envKey: "ORCA_REAL_ADAPTER_SMOKE_CODEX",
  create: (resolveFn) => new CodexAdapter(resolveFn),
});
