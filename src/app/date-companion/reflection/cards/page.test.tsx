import { afterEach, describe, expect, it, vi } from "vitest";

import DailyReflectionCardsPage from "./page";

const navigation = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  })
}));

vi.mock("next/navigation", () => ({ notFound: navigation.notFound }));
vi.mock("@/components/daily-reflection/daily-reflection-card-library", () => ({
  DailyReflectionCardLibrary: () => ({ type: "working-card-library", props: {}, key: null })
}));

const originalFlag = process.env.DAILY_REFLECTION_UPLOAD_ENABLED;

afterEach(() => {
  navigation.notFound.mockClear();
  if (originalFlag === undefined) delete process.env.DAILY_REFLECTION_UPLOAD_ENABLED;
  else process.env.DAILY_REFLECTION_UPLOAD_ENABLED = originalFlag;
});

describe("Daily Reflection Cards page", () => {
  it("uses the Daily Reflection feature boundary", () => {
    delete process.env.DAILY_REFLECTION_UPLOAD_ENABLED;
    expect(() => DailyReflectionCardsPage()).toThrow("NEXT_NOT_FOUND");

    process.env.DAILY_REFLECTION_UPLOAD_ENABLED = "true";
    expect(DailyReflectionCardsPage()).toMatchObject({
      type: expect.any(Function)
    });
  });
});
