import { afterEach, describe, expect, it, vi } from "vitest";

import DailyReflectionQueryPage from "./page";

const navigation = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  redirect: vi.fn((path: string) => { throw new Error(`NEXT_REDIRECT:${path}`); })
}));

vi.mock("next/navigation", () => navigation);

const originalFlag = process.env.DAILY_REFLECTION_UPLOAD_ENABLED;

afterEach(() => {
  navigation.notFound.mockClear();
  if (originalFlag === undefined) delete process.env.DAILY_REFLECTION_UPLOAD_ENABLED;
  else process.env.DAILY_REFLECTION_UPLOAD_ENABLED = originalFlag;
});

describe("Daily Reflection Query page", () => {
  it("uses the existing Daily Reflection feature boundary", () => {
    delete process.env.DAILY_REFLECTION_UPLOAD_ENABLED;
    expect(() => DailyReflectionQueryPage()).toThrow("NEXT_NOT_FOUND");

    process.env.DAILY_REFLECTION_UPLOAD_ENABLED = "true";
    expect(() => DailyReflectionQueryPage()).toThrow("NEXT_REDIRECT:/reflection/ask");
  });
});
