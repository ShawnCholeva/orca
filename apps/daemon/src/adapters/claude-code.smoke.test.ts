import { ClaudeCodeAdapter } from "./claude-code.js";
import { describeRealAdapterSmoke } from "./real-smoke.test-support.js";

describeRealAdapterSmoke({
  name: "ClaudeCodeAdapter",
  envKey: "ORCA_REAL_ADAPTER_SMOKE_CLAUDE_CODE",
  create: (resolveFn) => new ClaudeCodeAdapter(resolveFn),
});
