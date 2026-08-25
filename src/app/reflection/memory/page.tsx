import type { Metadata } from "next";

import { DailyReflectionMemory } from "@/components/daily-reflection/daily-reflection-memory";

export const metadata: Metadata = { title: "记忆 · Daily Reflection" };

export default function ReflectionMemoryPage() {
  return <DailyReflectionMemory />;
}
