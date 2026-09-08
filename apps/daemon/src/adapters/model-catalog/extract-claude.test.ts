import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseClaudeCatalog } from "./extract-claude.js";

const FIXTURE = readFileSync(
  join(__dirname, "__fixtures__", "claude-2.1.263-records.txt"),
  "utf8",
);

// A single record copied verbatim from the 2.1.263 bundle.
const OPUS_5 =
  '{id:"claude-opus-5",family:"opus",display_name:"Opus 5",knowledge_cutoff:"May 2026",' +
  'context:{window:1e6,native_1m:!0,supports_1m_beta:!0,supports_1m_suffix:!0},' +
  'max_output_tokens:{default:64000,upper:128000},pricing:"tier_5_25",' +
  'capabilities:["effort","max_effort","xhigh_effort","adaptive_thinking"],' +
  'default_effort:"high",effort_cost_index:{low:0.67,medium:0.76,high:1,xhigh:1.6,max:1.7},' +
  "advisor_rank:4}";

describe("parseClaudeCatalog", () => {
  it("maps the bundle's snake_case onto the Orca shape", () => {
    const [model] = parseClaudeCatalog(OPUS_5);
    expect(model).toEqual({
      id: "claude-opus-5",
      family: "opus",
      displayName: "Opus 5",
      contextWindow: 1_000_000,
      supports1mSuffix: true,
      pricingTier: "tier_5_25",
      advisorRank: 4,
      supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "high",
    });
  });

  it("derives supported efforts from the capability flags", () => {
    const noXhigh = OPUS_5.replace('"xhigh_effort",', "").replace('"max_effort",', "");
    const [model] = parseClaudeCatalog(noXhigh);
    expect(model.supportedEfforts).toEqual(["low", "medium", "high"]);
  });

  it("reports no supported efforts when the model lacks the effort capability", () => {
    const noEffort = OPUS_5.replace(
      'capabilities:["effort","max_effort","xhigh_effort","adaptive_thinking"]',
      'capabilities:["adaptive_thinking"]',
    );
    expect(parseClaudeCatalog(noEffort)[0].supportedEfforts).toEqual([]);
  });

  it("finds the real models in the captured bundle fixture", () => {
    const ids = parseClaudeCatalog(FIXTURE).map((m) => m.id);
    expect(ids).toContain("claude-opus-5");
    expect(ids).toContain("claude-fable-5-1");
  });

  it("gives every model in the fixture a display name", () => {
    for (const model of parseClaudeCatalog(FIXTURE)) {
      expect(model.displayName.length).toBeGreaterThan(0);
    }
  });

  it("returns empty for a blob with no records rather than throwing", () => {
    expect(parseClaudeCatalog("no records here")).toEqual([]);
  });

  it("skips a record missing an id instead of emitting a partial model", () => {
    expect(parseClaudeCatalog('{id:"claude-",family:"x"}')).toEqual([]);
  });

  it("drops a default_effort the effort enum does not know rather than casting it through", () => {
    const record = OPUS_5.replace('default_effort:"high"', 'default_effort:"ludicrous"');
    const [model] = parseClaudeCatalog(record);
    expect(model.defaultEffort).toBeNull();
  });
});
