import { z } from "zod";

import { DAILY_REFLECTION_RETURN_TIME_ZONE } from
  "@/lib/domain/daily-reflection-return";

const DateKeySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);

function dateParts(dateKey: string) {
  const parsed = DateKeySchema.parse(dateKey);
  const [year, month, day] = parsed.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.toISOString().slice(0, 10) !== parsed) {
    throw new Error("Invalid date key");
  }
  return date;
}

export function addDailyReflectionDateDays(dateKey: string, days: number) {
  const date = dateParts(dateKey);
  date.setUTCDate(date.getUTCDate() + z.number().int().parse(days));
  return date.toISOString().slice(0, 10);
}

export function dailyReflectionToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: DAILY_REFLECTION_RETURN_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return DateKeySchema.parse(`${value.year}-${value.month}-${value.day}`);
}

export function dailyReflectionSevenDayWindow(endDate: string) {
  const parsedEnd = DateKeySchema.parse(endDate);
  dateParts(parsedEnd);
  return {
    startDate: addDailyReflectionDateDays(parsedEnd, -6),
    endDate: parsedEnd,
    timeZone: DAILY_REFLECTION_RETURN_TIME_ZONE
  } as const;
}

export function stableDailyReflectionProjectionTimestamp(dateKey: string) {
  dateParts(dateKey);
  return `${dateKey}T00:00:00.000Z`;
}
