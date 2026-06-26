import { describe, expect, it } from "vitest";
import { resolveBinary } from "./resolve.js";

function makeAccessFn(executablePaths: Set<string>) {
  return async (p: string, _mode: number): Promise<void> => {
    if (!executablePaths.has(p)) throw new Error("ENOENT");
  };
}

describe("resolveBinary", () => {
  it("resolves a bare name found in PATH", async () => {
    const env = { PATH: "/usr/bin:/bin" };
    const accessFn = makeAccessFn(new Set(["/usr/bin/mybin"]));
    const result = await resolveBinary(["mybin"], { env, accessFn });
    expect(result).toEqual({ resolvedPath: "/usr/bin/mybin" });
  });

  it("returns not_found when bare name missing from all PATH dirs", async () => {
    const env = { PATH: "/usr/bin:/bin" };
    const accessFn = makeAccessFn(new Set());
    const result = await resolveBinary(["nothere"], { env, accessFn });
    expect(result).toMatchObject({ error: "not_found" });
    expect((result as { tried: string[] }).tried).toContain("/usr/bin/nothere");
    expect((result as { tried: string[] }).tried).toContain("/bin/nothere");
  });

  it("resolves an absolute path that is executable", async () => {
    const accessFn = makeAccessFn(new Set(["/custom/bin/tool"]));
    const result = await resolveBinary(["/custom/bin/tool"], { accessFn });
    expect(result).toEqual({ resolvedPath: "/custom/bin/tool" });
  });

  it("skips an absolute path missing X_OK and continues to next candidate", async () => {
    const env = { PATH: "/usr/bin" };
    const accessFn = makeAccessFn(new Set(["/usr/bin/fallback"]));
    const result = await resolveBinary(["/no/such/binary", "fallback"], { env, accessFn });
    expect(result).toEqual({ resolvedPath: "/usr/bin/fallback" });
    expect((result as { tried?: string[] }).tried).toBeUndefined();
  });

  it("records absolute path in tried list on miss", async () => {
    const accessFn = makeAccessFn(new Set());
    const result = await resolveBinary(["/no/such/binary"], { accessFn });
    expect(result).toMatchObject({ error: "not_found" });
    expect((result as { tried: string[] }).tried).toContain("/no/such/binary");
  });

  it("env override (absolute path) beats PATH when executable", async () => {
    const env = { PATH: "/usr/bin" };
    const accessFn = makeAccessFn(new Set(["/override/bin/tool", "/usr/bin/tool"]));
    const result = await resolveBinary(["/override/bin/tool", "tool"], { env, accessFn });
    expect(result).toEqual({ resolvedPath: "/override/bin/tool" });
  });

  it("env override miss falls through to PATH candidate", async () => {
    const env = { PATH: "/usr/bin" };
    const accessFn = makeAccessFn(new Set(["/usr/bin/tool"]));
    const result = await resolveBinary(["/bad/override", "tool"], { env, accessFn });
    expect(result).toEqual({ resolvedPath: "/usr/bin/tool" });
  });

  it("returns not_found with empty tried list when candidates is empty", async () => {
    const result = await resolveBinary([]);
    expect(result).toMatchObject({ error: "not_found", tried: [] });
  });
});
