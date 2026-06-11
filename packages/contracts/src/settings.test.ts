import { describe, expect, it } from "vitest";
import { SupervisionMode, AppSettings, PutSettingsRequest } from "./index.js";

describe("settings contracts", () => {
  it("accepts both supervision modes", () => {
    expect(SupervisionMode.parse("supervised")).toBe("supervised");
    expect(SupervisionMode.parse("unsupervised")).toBe("unsupervised");
  });

  it("rejects unknown modes", () => {
    expect(() => SupervisionMode.parse("auto")).toThrow();
  });

  it("AppSettings round-trips", () => {
    const s = AppSettings.parse({ supervisionMode: "supervised" });
    expect(s.supervisionMode).toBe("supervised");
  });

  it("PutSettingsRequest requires a valid mode", () => {
    expect(() => PutSettingsRequest.parse({})).toThrow();
    expect(PutSettingsRequest.parse({ supervisionMode: "unsupervised" }).supervisionMode).toBe(
      "unsupervised"
    );
  });
});
