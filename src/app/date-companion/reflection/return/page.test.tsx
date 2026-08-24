import { afterEach, describe, expect, it, vi } from "vitest";

import DailyReflectionReturnPage from "./page";

const navigation = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  })
}));

vi.mock("next/navigation", () => ({ notFound: navigation.notFound }));
vi.mock("@/components/daily-reflection/daily-reflection-return", () => ({
  DailyReflectionReturn: () => ({ type: "daily-reflection-return", props: {}, key: null })
}));

const originalFlag = process.env.DAILY_REFLECTION_UPLOAD_ENABLED;

afterEach(() => {
  navigation.notFound.mockClear();
  if (originalFlag === undefined) delete process.env.DAILY_REFLECTION_UPLOAD_ENABLED;
  else process.env.DAILY_REFLECTION_UPLOAD_ENABLED = originalFlag;
});

describe("Daily Reflection Return page", () => {
  it("uses the existing Daily Reflection feature boundary", () => {
    delete process.env.DAILY_REFLECTION_UPLOAD_ENABLED;
    expect(() => DailyReflectionReturnPage()).toThrow("NEXT_NOT_FOUND");

    process.env.DAILY_REFLECTION_UPLOAD_ENABLED = "true";
    expect(DailyReflectionReturnPage()).toMatchObject({
      type: expect.any(Function)
    });
  });
});
