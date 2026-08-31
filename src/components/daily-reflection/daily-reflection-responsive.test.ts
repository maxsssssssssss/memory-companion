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

  it("centers every desktop navigation label inside its touch target", () => {
    expect(css).toMatch(
      /\.reflectionDesktopNav a\s*\{[^}]*display:\s*inline-flex[^}]*min-height:\s*44px[^}]*align-items:\s*center[^}]*justify-content:\s*center[^}]*line-height:\s*1\.2[^}]*white-space:\s*nowrap/u
    );
  });

  it("keeps safe-area navigation, reachable touch controls, and reduced motion", () => {
    expect(css).toContain("env(safe-area-inset-bottom)");
    expect(css).toMatch(/\.reflectionMobileNav\s*\{[^}]*background:\s*var\(--dr-surface\);/u);
    expect(css).toMatch(/\.finalizePanelIdle\s*\{[^}]*box-shadow:\s*none;/u);
    expect(css).toMatch(/\.reviewSection\s*\{[^}]*scroll-padding-bottom:\s*96px;/u);
    expect(css).toMatch(/\.candidateActions button[^}]*min-height:\s*46px/u);
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain(".reflectionMobileNav .reflectionMobilePrimary { transform: none; }");
  });

  it("keeps the Card Library two-column on desktop and one-column on mobile", () => {
    const cardGrid = css.indexOf(".cardAssetGrid {");
    const phoneMedia = css.indexOf("@media (max-width: 620px)", cardGrid);
    const reducedMotion = css.lastIndexOf("@media (prefers-reduced-motion: reduce)");

    expect(css.slice(cardGrid, phoneMedia)).toMatch(
      /\.cardAssetGrid\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/u
    );
    expect(css.slice(cardGrid, phoneMedia)).toMatch(
      /\.cardAssetGrid\s*\{[^}]*grid-auto-rows:\s*1fr[^}]*align-items:\s*stretch/u
    );
    expect(css).toMatch(/\.cardAssetGrid\s*>\s*li\s*\{[^}]*height:\s*100%/u);
    expect(css).toMatch(/\.cardAsset\s*\{[^}]*height:\s*100%/u);
    expect(css.slice(phoneMedia, reducedMotion)).toMatch(
      /\.cardAssetGrid\s*\{[^}]*grid-template-columns:\s*1fr/u
    );
    expect(css).toMatch(/\.cardExpansionCard\s*\{[^}]*position:\s*fixed/u);
    expect(css).toMatch(/\.cardExpansionContent\s*\{[^}]*overflow-y:\s*auto/u);
    expect(css).toContain(".reflectionApp:has(.cardExpansionBackdrop) .reflectionMobileNav,");
    expect(css).toContain(".reflectionApp:has(.thinkingPanelBackdrop) .reflectionMobileNav { display: none; }");
  });

  it("places the Card expansion reduced-motion override after its transition rules", () => {
    const cardTransition = css.lastIndexOf(".cardExpansionCard {");
    const reducedMotion = css.lastIndexOf("@media (prefers-reduced-motion: reduce)");

    expect(cardTransition).toBeGreaterThan(-1);
    expect(reducedMotion).toBeGreaterThan(cardTransition);
    expect(css.slice(reducedMotion)).toContain(".cardExpansionCard,");
    expect(css.slice(reducedMotion)).toContain("transition: none !important;");
  });

  it("keeps the Memory archive two-column on desktop and safely focused on mobile", () => {
    const memoryGrid = css.indexOf(".memoryArchiveGrid {");
    const phoneMedia = css.indexOf("@media (max-width: 620px)", memoryGrid);
    const reducedMotion = css.lastIndexOf("@media (prefers-reduced-motion: reduce)");

    expect(css.slice(memoryGrid, phoneMedia)).toMatch(
      /\.memoryArchiveGrid\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/u
    );
    expect(css.slice(memoryGrid, phoneMedia)).toMatch(
      /\.memoryArchiveGrid\s*\{[^}]*grid-auto-rows:\s*1fr[^}]*align-items:\s*stretch/u
    );
    expect(css).toMatch(/\.recentMemoryGrid\s*\{[^}]*grid-auto-rows:\s*1fr[^}]*align-items:\s*stretch/u);
    expect(css).toMatch(/\.memoryArchiveCard\s*\{[^}]*height:\s*100%/u);
    expect(css.slice(phoneMedia, reducedMotion)).toMatch(
      /\.memoryArchiveGrid\s*\{[^}]*grid-template-columns:\s*1fr/u
    );
    expect(css.slice(phoneMedia, reducedMotion)).toMatch(
      /\.cardAssetGrid,\s*\.recentMemoryGrid,\s*\.memoryArchiveGrid\s*\{[^}]*grid-auto-rows:\s*auto/u
    );
    expect(css).toMatch(/\.memoryQuickView\s*\{[^}]*max-height:\s*min\(82dvh,\s*760px\)/u);
    expect(css).toMatch(/\.memoryQuickViewBody\s*\{[^}]*overflow-y:\s*auto/u);
    expect(css.slice(reducedMotion)).toContain(".memoryQuickView { animation: none; }");
  });
});
