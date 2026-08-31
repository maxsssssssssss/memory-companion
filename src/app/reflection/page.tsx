import type { Metadata } from "next";

import { ReflectionHome } from "@/components/daily-reflection/reflection-home";
import { DAILY_REFLECTION_RETURN_TIME_ZONE } from "@/lib/domain/daily-reflection-return";

export const metadata: Metadata = { title: "今天 · Daily Reflection" };

function homeDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    day: "numeric",
    month: "numeric",
    timeZone: DAILY_REFLECTION_RETURN_TIME_ZONE,
    weekday: "long",
    year: "numeric"
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  const year = value("year");
  const month = value("month");
  const day = value("day");
  return {
    dateKey: `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`,
    dateLabel: `${Number(month)} 月 ${Number(day)} 日`,
    weekdayLabel: value("weekday")
  };
}

export default function ReflectionHomePage() {
  return <ReflectionHome {...homeDate()} />;
}
