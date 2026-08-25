import { afterEach, describe, expect, it, vi } from "vitest";

import DailyReflectionCardsPage from "./page";

const navigation = vi.hoisted(() => ({
  notFound: vi.fn(() => { throw new Error("NEXT_NOT_FOUND"); }),
  redirect: vi.fn((path: string) => { throw new Error(`NEXT_REDIRECT:${path}`); })
}));

vi.mock("next/navigation", () => navigation);

const originalFlag = process.env.DAILY_REFLECTION_UPLOAD_ENABLED;

afterEach(() => {
  vi.clearAllMocks();
  if (originalFlag === undefined) delete process.env.DAILY_REFLECTION_UPLOAD_ENABLED;
  else process.env.DAILY_REFLECTION_UPLOAD_ENABLED = originalFlag;
});

describe("legacy Daily Reflection Cards route", () => {
  it("keeps the feature boundary closed", async () => {
    delete process.env.DAILY_REFLECTION_UPLOAD_ENABLED;
    await expect(DailyReflectionCardsPage({ searchParams: Promise.resolve({}) }))
      .rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("redirects list and detail links to canonical routes", async () => {
    process.env.DAILY_REFLECTION_UPLOAD_ENABLED = "true";
    await expect(DailyReflectionCardsPage({ searchParams: Promise.resolve({}) }))
      .rejects.toThrow("NEXT_REDIRECT:/reflection/cards");
    await expect(DailyReflectionCardsPage({ searchParams: Promise.resolve({ cardId: " card_1 " }) }))
      .rejects.toThrow("NEXT_REDIRECT:/reflection/cards/card_1");
  });
});
