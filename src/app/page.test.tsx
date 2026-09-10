import { afterEach, describe, expect, it, vi } from "vitest";

import GlobalProductEntryPage from "./page";

vi.mock("@/components/product-system/global-product-entry-boundary", () => ({
  GlobalProductEntryBoundary: (props: { dailyReflectionEnabled: boolean; workReviewEnabled: boolean }) => ({
    type: "global-product-entry-boundary",
    props,
    key: null
  })
}));

const originalFlag = process.env.DAILY_REFLECTION_UPLOAD_ENABLED;
const originalWorkFlag = process.env.WORK_REVIEW_ENABLED;

describe("global product entry", () => {
  afterEach(() => {
    if (originalFlag === undefined) delete process.env.DAILY_REFLECTION_UPLOAD_ENABLED;
    else process.env.DAILY_REFLECTION_UPLOAD_ENABLED = originalFlag;
    if (originalWorkFlag === undefined) delete process.env.WORK_REVIEW_ENABLED;
    else process.env.WORK_REVIEW_ENABLED = originalWorkFlag;
  });

  it.each([
    [undefined, false],
    ["false", false],
    ["true", true]
  ] as const)("keeps the Daily Reflection feature boundary for flag %s", (flag, expected) => {
    if (flag === undefined) delete process.env.DAILY_REFLECTION_UPLOAD_ENABLED;
    else process.env.DAILY_REFLECTION_UPLOAD_ENABLED = flag;
    delete process.env.WORK_REVIEW_ENABLED;

    const page = GlobalProductEntryPage();
    expect(page.props).toEqual({ dailyReflectionEnabled: expected, workReviewEnabled: true });
  });

  it.each([
    [undefined, true],
    ["false", false],
    ["true", true]
  ] as const)("keeps the Work Review feature boundary for flag %s", (flag, expected) => {
    delete process.env.DAILY_REFLECTION_UPLOAD_ENABLED;
    if (flag === undefined) delete process.env.WORK_REVIEW_ENABLED;
    else process.env.WORK_REVIEW_ENABLED = flag;

    const page = GlobalProductEntryPage();
    expect(page.props).toEqual({ dailyReflectionEnabled: false, workReviewEnabled: expected });
  });
});
