import { afterEach, describe, expect, it, vi } from "vitest";

import DailyReflectionCardsPage from "./page";

const navigation = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  })
}));

vi.mock("next/navigation", () => ({ notFound: navigation.notFound }));
vi.mock("@/components/daily-reflection/daily-reflection-card-library", () => ({
  DailyReflectionCardLibrary: (props: { initialCardId?: string | null }) => ({
    type: "working-card-library",
    props,
    key: null
  })
}));

const originalFlag = process.env.DAILY_REFLECTION_UPLOAD_ENABLED;

afterEach(() => {
  navigation.notFound.mockClear();
  if (originalFlag === undefined) delete process.env.DAILY_REFLECTION_UPLOAD_ENABLED;
  else process.env.DAILY_REFLECTION_UPLOAD_ENABLED = originalFlag;
});

describe("Daily Reflection Cards page", () => {
  it("uses the Daily Reflection feature boundary", async () => {
    delete process.env.DAILY_REFLECTION_UPLOAD_ENABLED;
    await expect(DailyReflectionCardsPage()).rejects.toThrow("NEXT_NOT_FOUND");

    process.env.DAILY_REFLECTION_UPLOAD_ENABLED = "true";
    await expect(DailyReflectionCardsPage()).resolves.toMatchObject({
      type: expect.any(Function)
    });
  });

  it("passes only one normalized Card id to the library", async () => {
    process.env.DAILY_REFLECTION_UPLOAD_ENABLED = "true";
    const selected = await DailyReflectionCardsPage({
      searchParams: Promise.resolve({ cardId: "  card_1  " })
    });
    expect(selected.props.initialCardId).toBe("card_1");

    const repeated = await DailyReflectionCardsPage({
      searchParams: Promise.resolve({ cardId: ["card_1", "card_2"] })
    });
    expect(repeated.props.initialCardId).toBeNull();
  });
});
