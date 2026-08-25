import { afterEach, describe, expect, it, vi } from "vitest";

import DailyReflectionPage from "./page";

const navigationMocks = vi.hoisted(() => ({
  notFound: vi.fn(() => { throw new Error("NEXT_NOT_FOUND"); }),
  redirect: vi.fn((path: string) => { throw new Error(`NEXT_REDIRECT:${path}`); })
}));

vi.mock("next/navigation", () => navigationMocks);

const originalFlag = process.env.DAILY_REFLECTION_UPLOAD_ENABLED;

afterEach(() => {
  vi.clearAllMocks();
  if (originalFlag === undefined) delete process.env.DAILY_REFLECTION_UPLOAD_ENABLED;
  else process.env.DAILY_REFLECTION_UPLOAD_ENABLED = originalFlag;
});

describe("legacy Daily Reflection route", () => {
  it("keeps the feature boundary closed", async () => {
    delete process.env.DAILY_REFLECTION_UPLOAD_ENABLED;
    await expect(DailyReflectionPage({ searchParams: Promise.resolve({}) }))
      .rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("redirects the old root to the canonical home", async () => {
    process.env.DAILY_REFLECTION_UPLOAD_ENABLED = "true";
    await expect(DailyReflectionPage({ searchParams: Promise.resolve({}) }))
      .rejects.toThrow("NEXT_REDIRECT:/reflection");
  });

  it("preserves a valid reflection and source deep link", async () => {
    process.env.DAILY_REFLECTION_UPLOAD_ENABLED = "true";
    await expect(DailyReflectionPage({
      searchParams: Promise.resolve({ reflectionId: " reflection-1 ", segmentId: " segment-1 " })
    })).rejects.toThrow("NEXT_REDIRECT:/reflection/sessions/reflection-1?segment=segment-1");
  });
});
