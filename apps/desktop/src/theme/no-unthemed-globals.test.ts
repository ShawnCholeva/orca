import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The app ships two stylesheets with different colour vocabularies. `theme.css`
// reads tokens applied to <html> at runtime and follows the active theme;
// `styles.css` predates it and hardcodes a light palette. That split is fine as
// long as every hardcoded rule stays SCOPED to a class — those rules paint the
// light-background panels they were written for and reach nothing else.
//
// An UNSCOPED rule is the one that breaks it. `h2 { color: #1a1a1a }` applies to
// every <h2> in the app, including ones on themed dark surfaces, and it wins over
// the inherited body colour because inheritance loses to any matching rule. That
// is C13: the run detail's title rendered #1a1a1a on #0B1020 — 1.09:1 contrast,
// against a 4.5:1 requirement — so the panel simply had no visible title, while
// the <span> beside it carried its own colour and stayed readable.
//
// This guards the mechanism rather than the instance. A unit test cannot catch
// the instance: happy-dom never loads the stylesheet, so the rendered component
// looks correct in every existing test and did.
describe("styles.css must not set colour on an unscoped selector", () => {
  const css = readFileSync(join(__dirname, "..", "styles.css"), "utf8");

  // A selector is scoped if any part of it names a class, id, or attribute.
  // `.form-field input` is scoped; `h2` and `body` are not.
  const isScoped = (selector: string) => /[.#[]/.test(selector);

  const offenders: string[] = [];
  for (const [, selectorList, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/(?<![-\w])color\s*:/.test(body)) continue;
    for (const selector of selectorList.split(",")) {
      const s = selector.trim();
      if (!s || s.startsWith("@") || s.startsWith("*")) continue;
      if (!isScoped(s)) offenders.push(s);
    }
  }

  it("has no unscoped colour declarations", () => {
    expect(offenders).toEqual([]);
  });
});
