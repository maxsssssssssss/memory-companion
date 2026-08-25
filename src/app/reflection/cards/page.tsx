import type { Metadata } from "next";

import { DailyReflectionCardLibrary } from "@/components/daily-reflection/daily-reflection-card-library";

export const metadata: Metadata = { title: "卡片 · Daily Reflection" };

export default function ReflectionCardsPage() {
  return <DailyReflectionCardLibrary embedded />;
}
