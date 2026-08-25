import { notFound, redirect } from "next/navigation";
import { isDailyReflectionUploadEnabled } from "@/lib/server/daily-reflection/runtime-config";

type DailyReflectionCardsPageProps = Readonly<{
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}>;

export default async function DailyReflectionCardsPage({ searchParams }: DailyReflectionCardsPageProps) {
  if (!isDailyReflectionUploadEnabled()) notFound();
  const query = await searchParams;
  const rawCardId = Array.isArray(query?.cardId) ? query?.cardId[0] : query?.cardId;
  const cardId = rawCardId?.trim();
  redirect(cardId ? `/reflection/cards/${encodeURIComponent(cardId)}` : "/reflection/cards");
}
