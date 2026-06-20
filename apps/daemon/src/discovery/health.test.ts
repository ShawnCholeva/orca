import { describe, it, expect } from "vitest";
import { probeHealth } from "./health.js";

function makeFetch(status: number, body: unknown): typeof fetch {
  return async (_input: RequestInfo | URL, _init?: RequestInit) => {
    return new Response(JSON.stringify(body), { status });
  };
}

function throwingFetch(_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> {
  return Promise.reject(new Error("network error"));
}

describe("probeHealth", () => {
  it("returns true for healthy 200 {service:'orca-daemon'}", async () => {
    const result = await probeHealth("http://127.0.0.1:1234", makeFetch(200, { service: "orca-daemon" }));
    expect(result).toBe(true);
  });

  it("returns false for {service:'other'}", async () => {
    const result = await probeHealth("http://127.0.0.1:1234", makeFetch(200, { service: "other" }));
    expect(result).toBe(false);
  });

  it("returns false for non-200 response", async () => {
    const result = await probeHealth("http://127.0.0.1:1234", makeFetch(503, { service: "orca-daemon" }));
    expect(result).toBe(false);
  });

  it("returns false when fetch throws", async () => {
    const result = await probeHealth("http://127.0.0.1:1234", throwingFetch as typeof fetch);
    expect(result).toBe(false);
  });
});
