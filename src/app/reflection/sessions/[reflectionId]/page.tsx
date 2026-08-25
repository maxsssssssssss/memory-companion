import type { Metadata } from "next";

import { ReflectionSession } from "@/components/daily-reflection/reflection-session";

export const metadata: Metadata = { title: "本次复盘 · Daily Reflection" };

export default async function ReflectionSessionPage({
  params,
  searchParams
}: Readonly<{
  params: Promise<{ reflectionId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}>) {
  const [{ reflectionId }, query] = await Promise.all([params, searchParams]);
  const rawSegment = Array.isArray(query?.segment) ? query?.segment[0] : query?.segment;
  return <ReflectionSession reflectionId={reflectionId} segmentId={rawSegment ?? null} />;
}
