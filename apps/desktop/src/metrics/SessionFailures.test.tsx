import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionFailures } from "./SessionFailures";
import * as api from "../api";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const day = (n: number) => `2026-09-0${n}T00:00:00.000Z`;

function mockSeries() {
  vi.spyOn(api, "getTimeseries").mockResolvedValue({
    from: day(1), to: day(4), bucket: "day",
    series: [
      {
        id: "session_started", label: "Agent sessions started",
        placedBy: "session.created event", caveat: null,
        points: [
          { at: day(1), count: 14 }, { at: day(2), count: 0 },
          { at: day(3), count: 6 }, { at: day(4), count: 0 },
        ],
      },
      {
        id: "session_failed", label: "Agent sessions that failed",
        placedBy: "session.failed event",
        caveat: "Recorded when the daemon noticed the failure, not when the worker died.",
        points: [
          { at: day(1), count: 12 }, { at: day(2), count: 0 },
          { at: day(3), count: 2 }, { at: day(4), count: 0 },
        ],
      },
    ],
  });
}

describe("failed sessions are a subset, not a second category", () => {
  it("reports the subset relationship and never their sum", async () => {
    // Every failed session was also a started one. Stacking would render 20 + 14 = 34
    // and imply the two partition a total — so the chart nests them and the legend
    // says "of them". The sum is the number that must never appear.
    mockSeries();
    render(<SessionFailures />);
    expect(await screen.findByText(/20 started/)).toBeInTheDocument();
    expect(screen.getByText(/14 of them failed/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("34");
  });

  it("renders every bucket the server sent, including the empty ones", async () => {
    // A zero is an observation. The daemon emits empty buckets deliberately, because
    // the gap between "nothing happened that day" and "no bucket" is exactly what a
    // renderer must not be left to invent — so they are not filtered out here.
    mockSeries();
    const { container } = render(<SessionFailures />);
    await screen.findByText(/20 started/);
    expect(container.querySelectorAll("[title]")).toHaveLength(4);
  });

  it("surfaces the caveat and the provenance the wire carries", async () => {
    // A bare count over time hides whether its timestamps mean what the reader
    // assumes. The daemon puts `placedBy` and `caveat` on the wire rather than
    // leaving them to us, so swallowing them in the renderer would undo the point.
    mockSeries();
    render(<SessionFailures />);
    expect(await screen.findByText(/Recorded when the daemon noticed the failure/)).toBeInTheDocument();
    expect(document.body.textContent).toContain("session.created event");
    expect(document.body.textContent).toContain("session.failed event");
  });

  it("names the bucket the server chose rather than assuming one", async () => {
    // The server picks the bucket from the window and reports it. Hardcoding "day"
    // would break silently the first time the window changes.
    mockSeries();
    render(<SessionFailures />);
    expect(await screen.findByText(/Agent sessions per day/)).toBeInTheDocument();
  });
});

describe("the panel cannot disappear", () => {
  it("says the fetch failed, and offers a retry, instead of rendering nothing", async () => {
    // It previously returned null on failure, so when the client parsed the wrong
    // shape the chart deleted itself and left no evidence it was meant to exist. A
    // reader could not tell "nothing happened" from "nothing loaded" from "nobody
    // built it" — the untyped absence this whole screen exists to remove.
    vi.spyOn(api, "getTimeseries").mockRejectedValue(new Error("500"));
    render(<SessionFailures />);
    expect(await screen.findByText(/Couldn't load this series/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Try again/ })).toBeInTheDocument();
  });

  it("states an empty window as an observation rather than vanishing", async () => {
    vi.spyOn(api, "getTimeseries").mockResolvedValue({
      from: day(1), to: day(4), bucket: "day",
      series: [{ id: "session_started", label: "Agent sessions started",
                 placedBy: "session.created event", caveat: null, points: [] }],
    });
    render(<SessionFailures />);
    expect(await screen.findByText(/No agent sessions were recorded/)).toBeInTheDocument();
  });
});
