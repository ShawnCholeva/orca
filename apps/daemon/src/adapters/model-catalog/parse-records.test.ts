import { describe, expect, it } from "vitest";
import { extractObjectLiterals, jsLiteralToJson } from "./parse-records.js";

describe("extractObjectLiterals", () => {
  it("returns a balanced literal starting at the marker", () => {
    const out = extractObjectLiterals('noise{id:"claude-a",n:{x:1}}tail', '{id:"claude-');
    expect(out).toEqual(['{id:"claude-a",n:{x:1}}']);
  });

  it("finds every occurrence", () => {
    const out = extractObjectLiterals('{id:"claude-a"},{id:"claude-b"}', '{id:"claude-');
    expect(out).toHaveLength(2);
  });

  it("ignores braces inside string values", () => {
    const out = extractObjectLiterals('{id:"claude-a",d:"a}b{c"}', '{id:"claude-');
    expect(out).toEqual(['{id:"claude-a",d:"a}b{c"}']);
  });

  it("ignores an escaped quote inside a string value", () => {
    const out = extractObjectLiterals('{id:"claude-a",d:"say \\"hi\\""}', '{id:"claude-');
    expect(out).toEqual(['{id:"claude-a",d:"say \\"hi\\""}']);
  });

  it("drops an unterminated literal rather than returning a truncated one", () => {
    expect(extractObjectLiterals('{id:"claude-a",n:{x:1}', '{id:"claude-')).toEqual([]);
  });

  it("returns empty when the marker is absent", () => {
    expect(extractObjectLiterals("nothing here", '{id:"claude-')).toEqual([]);
  });
});

describe("jsLiteralToJson", () => {
  it("quotes unquoted keys", () => {
    expect(jsLiteralToJson('{id:"a",family:"opus"}')).toEqual({ id: "a", family: "opus" });
  });

  it("reads the minified booleans", () => {
    expect(jsLiteralToJson("{a:!0,b:!1}")).toEqual({ a: true, b: false });
  });

  it("reads exponent numerics", () => {
    expect(jsLiteralToJson("{window:1e6}")).toEqual({ window: 1_000_000 });
  });

  it("does not rewrite a key-like sequence inside a string value", () => {
    expect(jsLiteralToJson('{d:"note: careful",e:1}')).toEqual({ d: "note: careful", e: 1 });
  });

  it("handles nested objects and arrays", () => {
    expect(jsLiteralToJson('{c:{w:1e6,n:!0},caps:["effort","max_effort"]}'))
      .toEqual({ c: { w: 1_000_000, n: true }, caps: ["effort", "max_effort"] });
  });

  it("parses a single-quoted string value", () => {
    expect(jsLiteralToJson("{id:'claude-x',n:1}")).toEqual({ id: "claude-x", n: 1 });
  });

  it("escapes a double quote carried inside a single-quoted string", () => {
    expect(jsLiteralToJson(`{d:'say "hi"'}`)).toEqual({ d: 'say "hi"' });
  });

  it("returns null for a literal it cannot convert", () => {
    expect(jsLiteralToJson("{a:(function(){})()}")).toBeNull();
  });
});
