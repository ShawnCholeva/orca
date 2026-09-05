import { describe, expect, it } from "vitest";
import { bucketFor, bucketStartMs, BUCKET_MS } from "./timeseries.js";

const DAY = 86_400_000;

describe("bucketFor", () => {
  it("picks a granularity the caller cannot get wrong", () => {
    // A caller choosing blindly gets a six-week window in hour buckets — a
    // thousand buckets of mostly zero, which is a chart that renders and says
    // nothing. The server picks and reports it.
    expect(bucketFor(2 * DAY)).toBe("hour");
    expect(bucketFor(30 * DAY)).toBe("day");
    expect(bucketFor(365 * DAY)).toBe("week");
  });

  it("keeps a chart inside a legible number of points at every tier", () => {
    for (const windowMs of [DAY, 3 * DAY, 30 * DAY, 112 * DAY, 365 * DAY]) {
      const points = windowMs / BUCKET_MS[bucketFor(windowMs)];
      expect(points).toBeGreaterThanOrEqual(12);
      expect(points).toBeLessThanOrEqual(200);
    }
  });
});

describe("bucketStartMs", () => {
  it("floors to the bucket so two events in one hour share a point", () => {
    const a = Date.parse("2026-09-01T04:10:00.000Z");
    const b = Date.parse("2026-09-01T04:55:00.000Z");
    expect(bucketStartMs(a, "hour")).toBe(bucketStartMs(b, "hour"));
    expect(new Date(bucketStartMs(a, "hour")).toISOString()).toBe("2026-09-01T04:00:00.000Z");
  });

  it("separates events that fall either side of a boundary", () => {
    const a = Date.parse("2026-09-01T23:59:00.000Z");
    const b = Date.parse("2026-09-02T00:01:00.000Z");
    expect(bucketStartMs(a, "day")).not.toBe(bucketStartMs(b, "day"));
  });
});
