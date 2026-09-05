import { afterEach, describe, expect, it, vi } from "vitest";
import { TimeseriesResponse } from "@orca/contracts";
import { getTimeseries } from "../api";

afterEach(() => vi.restoreAllMocks());

// The gap four other guards don't cover, because it lives BETWEEN the client and the
// server rather than inside either.
//
// `getTimeseries` parsed the envelope as the payload, so `.strict()` rejected every
// real response and the panel rendered nothing at all. The component suite was green
// throughout: it mocked `getTimeseries` itself and handed the renderer the unwrapped
// shape the client *expected*, which validated the renderer against a contract the
// server does not honour. A mock is an unverified claim about a contract, and that
// claim was false.
//
// So this test mocks `fetch` rather than the client — the real URL construction, the
// real unwrap and the real zod parse all execute. The fixture is the shape the daemon
// actually returns, and it is validated against the SCHEMA before use, so a fixture
// that drifts from the contract fails here rather than silently passing.

function daemonResponse() {
  const payload = {
    from: "2026-08-06T00:00:00.000Z",
    to: "2026-09-05T00:00:00.000Z",
    bucket: "day" as const,
    series: [
      {
        id: "session_started" as const, label: "Agent sessions started",
        placedBy: "session.created event", caveat: null,
        points: [{ at: "2026-09-01T00:00:00.000Z", count: 14 }, { at: "2026-09-02T00:00:00.000Z", count: 0 }],
      },
    ],
  };
  // The fixture must satisfy the contract, or this test proves nothing about it.
  TimeseriesResponse.parse(payload);
  return { timeseries: payload };
}

describe("the timeseries client reads the shape the daemon actually sends", () => {
  it("unwraps the envelope rather than parsing it as the payload", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => daemonResponse(),
    }));
    const res = await getTimeseries(["session_started"], "2026-08-06T00:00:00.000Z", "2026-09-05T00:00:00.000Z");
    expect(res.bucket).toBe("day");
    expect(res.series[0]!.points).toHaveLength(2);
  });

  it("rejects a bare payload, so the envelope cannot quietly change shape", async () => {
    // The inverse of the bug: if the server ever stopped wrapping, this fails loudly
    // instead of the panel disappearing.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => daemonResponse().timeseries,
    }));
    await expect(
      getTimeseries(["session_started"], "2026-08-06T00:00:00.000Z", "2026-09-05T00:00:00.000Z"),
    ).rejects.toThrow();
  });
});
