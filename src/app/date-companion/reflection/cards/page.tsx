import { notFound } from "next/navigation";

import { DailyReflectionCardLibrary } from "@/components/daily-reflection/daily-reflection-card-library";
import { isDailyReflectionUploadEnabled } from "@/lib/server/daily-reflection/runtime-config";

type DailyReflectionCardsPageProps = Readonly<{
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}>;

export default async function DailyReflectionCardsPage({ searchParams }: DailyReflectionCardsPageProps = {}) {
  if (!isDailyReflectionUploadEnabled()) notFound();
  const rawCardId = (await searchParams)?.cardId;
  const initialCardId = typeof rawCardId === "string" && rawCardId.trim()
    ? rawCardId.trim()
    : null;
  return <DailyReflectionCardLibrary initialCardId={initialCardId} />;
}
