import { useEffect, useState } from "react";
import type { TimeseriesResponse } from "@orca/contracts";
import { scaleTime } from "d3-scale";
import { timeFormat } from "d3-time-format";
import { getTimeseries } from "../api";
import { NestedBars, Panel, TimeAxis } from "./dashboard-panels";

// Agent sessions started, and how many of them failed, over calendar time.
//
// The constraint that decides the chart: `session_failed` is a SUBSET of
// `session_started`. A failed session was also a started one, so stacking them would
// render 56 + 30 = 86 and imply they partition a total. They are nested, and the
// chart draws them that way.
//
// Everything the wire carries about provenance is rendered, because the daemon put it
// there rather than leaving it to us: `placedBy` says which record each series is
// timestamped by, and `caveat` says that a failure is stamped when the daemon NOTICED
// it — a grace window plus a tick after the worker actually died. A count over time
// hides whether its timestamps mean what the reader assumes, and that is precisely
// what these two fields exist to stop.
//
// d3 earns its place here and not before: `scaleTime` and `d3-time-format` choose and
// label ticks across whichever bucket the server picked. The bucket is the server's
// choice and is reported on the wire — rendering `day` because today it is `day` would
// break silently the first time the window changes.

const DAYS_BACK = 42;

export function SessionFailures() {
  const [data, setData] = useState<TimeseriesResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let live = true;
    setFailed(false);
    const to = new Date();
    const from = new Date(to.getTime() - DAYS_BACK * 86_400_000);
    getTimeseries(["session_started", "session_failed"], from.toISOString(), to.toISOString())
      .then((d) => { if (live) setData(d); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [reload]);

  // This panel must never be able to vanish.
  //
  // It previously returned `null` on a failed fetch, an empty response and a loading
  // state alike — so when the client parsed the wrong shape, the chart deleted itself
  // and left nothing on screen saying it had ever been meant to be there. The chart
  // built to make silent failure visible failed silently, and 926 green tests said
  // otherwise because the mock asserted a contract the server does not honour.
  //
  // A component that disappears on error is the untyped absence this whole screen
  // exists to remove: a reader cannot tell "nothing happened" from "nothing loaded"
  // from "nobody built it".
  if (failed) {
    return (
      <Panel title="Agent sessions over time" span={12}>
        <div style={{ display: "flex", alignItems: "baseline", gap: "var(--sp-2)" }}>
          <span style={{ fontSize: "var(--fs-3)", color: "var(--err)" }}>Couldn&apos;t load this series.</span>
          <button type="button" onClick={() => setReload((n) => n + 1)} style={{ fontSize: "var(--fs-2)", background: "none", border: "none", color: "var(--accent)", cursor: "pointer", padding: 0 }}>
            Try again
          </button>
        </div>
      </Panel>
    );
  }
  if (data === null) {
    return (
      <Panel title="Agent sessions over time" span={12}>
        <span style={{ fontSize: "var(--fs-3)", color: "var(--text-3)" }}>Loading…</span>
      </Panel>
    );
  }

  const started = data.series.find((s) => s.id === "session_started");
  const failedSeries = data.series.find((s) => s.id === "session_failed");
  if (!started || started.points.length === 0) {
    // An empty window is an observation, not an absence of the panel.
    return (
      <Panel title="Agent sessions over time" span={12}>
        <span style={{ fontSize: "var(--fs-3)", color: "var(--text-2)" }}>
          No agent sessions were recorded in the last {DAYS_BACK} days.
        </span>
      </Panel>
    );
  }

  const failedAt = new Map(failedSeries?.points.map((p) => [p.at, p.count]) ?? []);
  const buckets = started.points.map((p) => {
    const at = new Date(p.at).getTime();
    const subset = failedAt.get(p.at) ?? 0;
    return {
      at,
      total: p.count,
      subset,
      title: `${fmtDay(new Date(at))} — ${p.count} started, ${subset} of them failed`,
    };
  });

  const totalStarted = started.points.reduce((a, p) => a + p.count, 0);
  const totalFailed = failedSeries?.points.reduce((a, p) => a + p.count, 0) ?? 0;

  const t0 = buckets[0]!.at;
  const t1 = buckets[buckets.length - 1]!.at;
  const scale = scaleTime().domain([new Date(t0), new Date(t1)]).range([0, 100]);
  const ticks = scale.ticks(5).map((d) => ({
    at: d.getTime(),
    label: fmtDay(d),
    offsetPct: scale(d),
  }));

  return (
    <Panel title={`Agent sessions per ${data.bucket}, and how many failed`} span={12}>
      <NestedBars buckets={buckets} />
      <TimeAxis ticks={ticks} />
      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-3)" }}>
        <Legend tone="var(--accent-2)" text={`${totalStarted} started`} />
        <Legend tone="var(--err)" text={`${totalFailed} of them failed`} />
      </div>
      {/* Provenance, rendered rather than typed. A bare count over time hides whether
          its timestamps mean what the reader assumes. */}
      <div style={{ display: "grid", gap: 2 }}>
        <span className="mono" style={{ fontSize: "var(--fs-1)", color: "var(--text-3)" }}>
          {started.label}: placed by {started.placedBy} · {failedSeries?.label}: placed by {failedSeries?.placedBy}
        </span>
        {failedSeries?.caveat && (
          <span style={{ fontSize: "var(--fs-2)", color: "var(--text-2)" }}>{failedSeries.caveat}</span>
        )}
      </div>
    </Panel>
  );
}

function Legend({ tone, text }: { tone: string; text: string }) {
  return (
    <span className="mono" style={{ fontSize: "var(--fs-1)", color: "var(--text-2)" }}>
      <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: tone, marginRight: 5, verticalAlign: -1 }} />
      {text}
    </span>
  );
}

const fmtDay = timeFormat("%b %-d");
