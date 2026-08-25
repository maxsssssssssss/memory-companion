import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(
  process.cwd(),
  "src/components/daily-reflection/daily-reflection.module.css"
), "utf8");

describe("Daily Reflection responsive product shell", () => {
  it("places responsive overrides after base navigation rules", () => {
    const baseNavigation = css.indexOf(".reflectionMobileNav { display: none; }");
    const tabletMedia = css.indexOf("@media (max-width: 900px)");
    const phoneMedia = css.indexOf("@media (max-width: 620px)");

    expect(baseNavigation).toBeGreaterThan(-1);
    expect(tabletMedia).toBeGreaterThan(baseNavigation);
    expect(phoneMedia).toBeGreaterThan(tabletMedia);
    expect(css.slice(tabletMedia, phoneMedia)).toContain(".reflectionMobileNav {");
    expect(css.slice(tabletMedia, phoneMedia)).toContain("display: grid;");
  });

  it("keeps safe-area navigation, reachable touch controls, and reduced motion", () => {
    expect(css).toContain("env(safe-area-inset-bottom)");
    expect(css).toMatch(/\.candidateActions button[^}]*min-height:\s*46px/u);
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain(".reflectionMobileNav .reflectionMobilePrimary { transform: none; }");
  });
});
