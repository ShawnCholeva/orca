import { OpenCodeAdapter } from "./opencode.js";
import { describeRealAdapterSmoke } from "./real-smoke.test-support.js";

describeRealAdapterSmoke({
  name: "OpenCodeAdapter",
  envKey: "ORCA_REAL_ADAPTER_SMOKE_OPENCODE",
  create: (resolveFn) => new OpenCodeAdapter(resolveFn),
});
