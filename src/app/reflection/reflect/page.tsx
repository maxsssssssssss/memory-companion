import type { Metadata } from "next";

import { DailyReflectionReturn } from "@/components/daily-reflection/daily-reflection-return";

export const metadata: Metadata = { title: "回看 · Daily Reflection" };

export default function ReflectionReturnPage() {
  return <DailyReflectionReturn embedded />;
}
