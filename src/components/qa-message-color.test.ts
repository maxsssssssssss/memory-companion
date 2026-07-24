import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function cssRule(css: string, selector: string) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return css.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`, "u"))?.[1] ?? "";
}

describe("QA assistant message color", () => {
  const css = readFileSync(resolve(process.cwd(), "src/app/globals.css"), "utf8");

  it("uses pure black only for the assistant answer content rule", () => {
    expect(cssRule(css, ".qa-answer-content")).toMatch(/color:\s*#000000\s*;/u);
    expect(cssRule(css, ".msg.u .bub")).not.toContain("#000000");
    expect(cssRule(css, ".qa-citations")).not.toContain("#000000");
  });
});
