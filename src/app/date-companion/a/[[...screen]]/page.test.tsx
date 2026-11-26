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
    vi.unstubAllEnvs();
    navigationMocks.notFound.mockClear();
    restoreFlag("DAILY_BRIEF_TOY_SYNC_ENABLED", originalSharedFlag);
    restoreFlag("DAILY_REFLECTION_TOY_SYNC_ENABLED", originalLegacyFlag);
    restoreFlag("DAILY_REFLECTION_UPLOAD_ENABLED", originalReflectionFlag);
  });

  it("accepts a recording deep link regardless of retired edition flags", async () => {
    const page = (screen: string, view?: string) => DateCompanionScreenPage({
      params:Promise.resolve({screen:[screen]}), searchParams:Promise.resolve({view,recording:"recording-1"})
    });
    vi.stubEnv("DAILY_BRIEF_RECAP_TRIAL", "");
    expect((await page("recap", "book")).props.children.props.initialRecordingId).toBe("recording-1");
    vi.stubEnv("DAILY_BRIEF_RECAP_TRIAL", "1");
    expect((await page("recap")).props.children.props.initialRecordingId).toBe("recording-1");
    expect((await page("recap", "classic")).props.children.props).toEqual((await page("recap", "book")).props.children.props);
    expect((await page("people", "book")).props.children.props.initialRecordingId).toBeNull();
  });
  it("keeps discussion deep links and accepts both spellings of the records section", async () => {
    const page = (view?: string, section?: string) => DateCompanionScreenPage({ params: Promise.resolve({ screen: ["prepare"] }),
      searchParams: Promise.resolve({ view, section, preparation: "real-discussion", from: "book-home" }) });
    for (const view of [undefined, "classic", "book"]) {
      expect((await page(view)).props.children.props).toMatchObject({
        initialDiscussionId: "real-discussion", showPreparationRecords: false
      });
    }
    expect((await page("records")).props.children.props.showPreparationRecords).toBe(true);
    expect((await page(undefined, "records")).props.children.props.showPreparationRecords).toBe(true);
  });
  it("passes the same scrapbook screen and person identity for bare and historical links", async () => {
    const page = async (screen: string[], query: {view?: string; from?: string}) =>
      (await DateCompanionScreenPage({params: Promise.resolve({screen}), searchParams: Promise.resolve(query)})).props.children.props;
    vi.stubEnv("DAILY_BRIEF_RECAP_TRIAL", "1");
    expect((await page(["people"], {})).screen).toBe("people");
    expect(await page(["people"], {view:"classic",from:"book-home"})).toEqual(await page(["people"], {}));
    expect(await page(["people", "person-A"], {view:"book"})).toMatchObject({screen:"person", initialPersonId:"person-A"});
    expect(await page(["person"], {from:"book-home"})).toMatchObject({screen:"person", initialPersonId:null});
    vi.stubEnv("DAILY_BRIEF_RECAP_TRIAL", "");
    expect(await page(["person"], {view:"book"})).toEqual(await page(["person"], {}));
  });
  it("keeps an explicit new preparation draft distinct from the latest discussion on refresh", async () => {
    const page = (query: { draft?: string; preparation?: string }) => DateCompanionScreenPage({ params: Promise.resolve({ screen: ["prepare"] }), searchParams: Promise.resolve({ view: "book", ...query }) });
    expect((await page({ draft: "new" })).props.children.props.initialDiscussionId).toBeNull();
    expect((await page({})).props.children.props.initialDiscussionId).toBeUndefined();
    expect((await page({ draft: "new", preparation: "created-id" })).props.children.props.initialDiscussionId).toBe("created-id");
  });
  it("allows only local preparation return context on a recap", async () => {
    const page = (returnTo: string) => DateCompanionScreenPage({ params: Promise.resolve({ screen: ["recap"] }), searchParams: Promise.resolve({ returnTo }) });
    expect((await page("/date-companion/a/prepare?view=book&preparation=real-id")).props.children.props.preparationReturnTo)
      .toBe("/date-companion/a/prepare?preparation=real-id");
    expect((await page("https://example.com/date-companion/a/prepare")).props.children.props.preparationReturnTo).toBeNull();
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
