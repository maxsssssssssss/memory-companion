import { describe, expect, it } from "vitest";

import {
  addDailyReflectionDateDays,
  dailyReflectionSevenDayWindow,
  dailyReflectionToday,
  stableDailyReflectionProjectionTimestamp
} from "./return-time";

describe("Daily Reflection return calendar policy", () => {
  it("uses an inclusive seven-day date-only window across month and year boundaries", () => {
    expect(dailyReflectionSevenDayWindow("2026-03-01")).toEqual({
      startDate: "2026-02-23",
      endDate: "2026-03-01",
      timeZone: "Asia/Shanghai"
    });
    expect(dailyReflectionSevenDayWindow("2027-01-03")).toEqual({
      startDate: "2026-12-28",
      endDate: "2027-01-03",
      timeZone: "Asia/Shanghai"
    });
    expect(addDailyReflectionDateDays("2024-03-01", -1)).toBe("2024-02-29");
  });

  it("derives today at the Asia/Shanghai boundary instead of the host timezone", () => {
    expect(dailyReflectionToday(new Date("2026-08-23T15:59:59.999Z")))
      .toBe("2026-08-23");
    expect(dailyReflectionToday(new Date("2026-08-23T16:00:00.000Z")))
      .toBe("2026-08-24");
  });

  it("keeps projection timestamps deterministic and rejects impossible dates", () => {
    expect(stableDailyReflectionProjectionTimestamp("2026-08-24"))
      .toBe("2026-08-24T00:00:00.000Z");
    expect(stableDailyReflectionProjectionTimestamp("2026-08-24"))
      .toBe(stableDailyReflectionProjectionTimestamp("2026-08-24"));
    expect(() => dailyReflectionSevenDayWindow("2026-02-30")).toThrow();
    expect(() => addDailyReflectionDateDays("2026-13-01", 1)).toThrow();
    expect(() => addDailyReflectionDateDays("2026-08-24", 0.5)).toThrow();
  });
});
