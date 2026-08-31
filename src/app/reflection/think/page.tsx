import type { Metadata } from "next";

import { ReflectionThinkingWorkspace } from "@/components/daily-reflection/reflection-thinking-workspace";
import { ThinkingModeSchema } from "@/lib/domain/daily-reflection-thinking";

export const metadata: Metadata = { title: "一起想 · Daily Reflection" };

export default async function ReflectionThinkPage({
  searchParams
}: Readonly<{ searchParams?: Promise<Record<string, string | string[] | undefined>> }>) {
  const query = await searchParams;
  const rawMode = Array.isArray(query?.mode) ? query?.mode[0] : query?.mode;
  const parsedMode = ThinkingModeSchema.safeParse(rawMode);
  return <ReflectionThinkingWorkspace initialMode={parsedMode.success ? parsedMode.data : undefined} />;
}
