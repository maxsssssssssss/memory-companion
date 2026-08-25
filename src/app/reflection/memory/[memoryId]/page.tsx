import type { Metadata } from "next";

import { DailyReflectionMemory } from "@/components/daily-reflection/daily-reflection-memory";

export const metadata: Metadata = { title: "记忆 · Daily Reflection" };

export default async function ReflectionMemoryDetailPage({
  params
}: Readonly<{ params: Promise<{ memoryId: string }> }>) {
  const { memoryId } = await params;
  return <DailyReflectionMemory memoryId={memoryId} />;
}
