import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

// Form controls do not inherit type. A <button> takes the UA stylesheet's font
// unless told otherwise, so a bare button inside a themed container rendered Arial
// at 13.3333px: 103 of 163 elements on the Metrics tab, because the run rows are
// buttons and their children inherited the default too.
//
// WHAT THIS TEST CAN AND CANNOT DO, because the difference is the whole lesson.
// The type-scale test asserts over SOURCE LITERALS and could never have caught
// this — nothing in the source was wrong. The defect lived in the value that
// arrives when the source says nothing, which only exists once something renders.
//
// happy-dom applies the stylesheet rule but does not resolve inheritance: it
// reports the literal "inherit" rather than "Inter". So this proves the reset's
// SELECTOR MATCHES A BUTTON — strictly more than reading the file, and enough to
// catch the rule being dropped or narrowed — and it does NOT prove the rendered
// typeface. Verifying that needs a real engine, which is a Playwright pass by hand
// rather than anything in this suite.
//
// Naming the limit matters: a test whose name implies it checks rendering, sitting
// green over a screen in Arial, is worse than no test — it spends the reader's
// belief on a guarantee it never made.

const THEME_CSS = readFileSync(join(__dirname, "theme.css"), "utf8");

function withTheme(): HTMLStyleElement {
  const style = document.createElement("style");
  style.textContent = THEME_CSS;
  document.head.appendChild(style);
  return style;
}

afterEach(() => {
  document.head.querySelectorAll("style").forEach((s) => s.remove());
});

describe("form controls are covered by the type reset", () => {
  it("matches a bare button, so it stops taking the UA font", () => {
    withTheme();
    const { container } = render(
      <div style={{ fontFamily: "Inter", fontSize: "12px" }}>
        <button type="button">Adaptive Delivery</button>
      </div>
    );
    const cs = getComputedStyle(container.querySelector("button")!);
    // "inherit" here means the rule matched. Without it happy-dom reports the UA
    // default, which is the bug.
    expect(cs.fontFamily).toBe("inherit");
    expect(cs.fontSize).toBe("inherit");
  });

  it("covers every control that carries its own UA font, not just button", () => {
    // input/select/textarea have the same defect and the same fix; leaving one out
    // means the next form-shaped surface reintroduces it in a place nobody looks.
    withTheme();
    const { container } = render(
      <div>
        <input aria-label="a" />
        <select aria-label="b" />
        <textarea aria-label="c" />
      </div>
    );
    for (const tag of ["input", "select", "textarea"]) {
      expect(getComputedStyle(container.querySelector(tag)!).fontFamily, tag).toBe("inherit");
    }
  });
});
