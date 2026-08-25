import type { Metadata } from "next";

import { DailyReflectionCardLibrary } from "@/components/daily-reflection/daily-reflection-card-library";

export const metadata: Metadata = { title: "卡片 · Daily Reflection" };

export default async function ReflectionCardDetailPage({
  params
}: Readonly<{ params: Promise<{ cardId: string }> }>) {
  const { cardId } = await params;
  return <DailyReflectionCardLibrary detailOnly embedded initialCardId={cardId} />;
}
