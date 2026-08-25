import type { Metadata } from "next";

import { DailyReflectionQuery } from "@/components/daily-reflection/daily-reflection-query";

export const metadata: Metadata = { title: "问问过去 · Daily Reflection" };

export default async function ReflectionAskPage({
  searchParams
}: Readonly<{ searchParams?: Promise<Record<string, string | string[] | undefined>> }>) {
  const query = await searchParams;
  const rawQuestion = query?.q;
  const initialQuestion = Array.isArray(rawQuestion) ? rawQuestion[0] : rawQuestion;
  return <DailyReflectionQuery embedded initialQuestion={initialQuestion?.slice(0, 512) ?? ""} />;
}
