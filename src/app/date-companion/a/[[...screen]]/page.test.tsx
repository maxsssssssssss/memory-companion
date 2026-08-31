import { afterEach, describe, expect, it, vi } from "vitest";

import DateCompanionScreenPage from "./page";

const navigationMocks = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  })
}));

vi.mock("next/navigation", () => ({
  notFound: navigationMocks.notFound
}));

vi.mock("@/components/date-companion/date-companion-shell", () => ({
  DateCompanionPersistentShell: (props: {
    entry: "companion";
    dailyReflectionEnabled: boolean;
    initialInteractionId: string | null;
    initialPersonId: string | null;
    initialSegmentId: string | null;
    screen: string;
    toySyncEnabled: boolean;
  }) => ({
    type: "date-companion-persistent-shell",
    props,
    key: null
  })
}));

const originalSharedFlag = process.env.DAILY_BRIEF_TOY_SYNC_ENABLED;
const originalLegacyFlag = process.env.DAILY_REFLECTION_TOY_SYNC_ENABLED;
const originalReflectionFlag = process.env.DAILY_REFLECTION_UPLOAD_ENABLED;

function restoreFlag(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe("Date Companion screen page", () => {
  afterEach(() => {
    navigationMocks.notFound.mockClear();
    restoreFlag("DAILY_BRIEF_TOY_SYNC_ENABLED", originalSharedFlag);
    restoreFlag("DAILY_REFLECTION_TOY_SYNC_ENABLED", originalLegacyFlag);
    restoreFlag("DAILY_REFLECTION_UPLOAD_ENABLED", originalReflectionFlag);
  });

  it.each([
    [undefined, undefined, false],
    ["true", undefined, true],
    [undefined, "true", true],
    ["false", "true", false]
  ] as const)(
    "passes shared flag %s and legacy flag %s as %s",
    async (sharedFlag, legacyFlag, expected) => {
      restoreFlag("DAILY_BRIEF_TOY_SYNC_ENABLED", sharedFlag);
      restoreFlag("DAILY_REFLECTION_TOY_SYNC_ENABLED", legacyFlag);
      process.env.DAILY_REFLECTION_UPLOAD_ENABLED = "true";

      const element = await DateCompanionScreenPage({
        params: Promise.resolve({}),
        searchParams: Promise.resolve({})
      });

      expect(element.props.children.props).toMatchObject({
        entry: "companion",
        dailyReflectionEnabled: true,
        initialInteractionId: null,
        initialPersonId: null,
        initialSegmentId: null,
        screen: "home",
        toySyncEnabled: expected
      });
    }
  );

  it("passes only single non-empty interaction and segment query values", async () => {
    const element = await DateCompanionScreenPage({
      params: Promise.resolve({ screen: ["recap"] }),
      searchParams: Promise.resolve({
        interaction: "interaction-1",
        segment: "segment-1"
      })
    });

    expect(element.props.children.props).toMatchObject({
      initialInteractionId: "interaction-1",
      initialSegmentId: "segment-1",
      screen: "recap"
    });

    const arrayElement = await DateCompanionScreenPage({
      params: Promise.resolve({ screen: ["recap"] }),
      searchParams: Promise.resolve({
        interaction: ["interaction-1", "interaction-2"],
        segment: ["segment-1", "segment-2"]
      })
    });
    expect(arrayElement.props.children.props.initialInteractionId).toBeNull();
    expect(arrayElement.props.children.props.initialSegmentId).toBeNull();
  });

  it("maps a confirmed Person deep link onto the shared Person detail", async () => {
    const element = await DateCompanionScreenPage({
      params: Promise.resolve({ screen: ["people", "person-confirmed"] }),
      searchParams: Promise.resolve({})
    });

    expect(element.props.children.props).toMatchObject({
      initialPersonId: "person-confirmed",
      screen: "person"
    });
  });

  it("rejects unsupported or nested screens", async () => {
    await expect(DateCompanionScreenPage({
      params: Promise.resolve({ screen: ["missing"] }),
      searchParams: Promise.resolve({})
    })).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(DateCompanionScreenPage({
      params: Promise.resolve({ screen: ["home", "nested"] }),
      searchParams: Promise.resolve({})
    })).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(DateCompanionScreenPage({
      params: Promise.resolve({ screen: ["people", "person", "nested"] }),
      searchParams: Promise.resolve({})
    })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(navigationMocks.notFound).toHaveBeenCalledTimes(3);
  });
});
