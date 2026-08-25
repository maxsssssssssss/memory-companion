import { notFound, redirect } from "next/navigation";

import { isDailyReflectionUploadEnabled } from "@/lib/server/daily-reflection/runtime-config";

type DailyReflectionPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function DailyReflectionPage({ searchParams }: DailyReflectionPageProps) {
  if (!isDailyReflectionUploadEnabled()) notFound();

  const query = await searchParams;
  const rawReflectionId = Array.isArray(query?.reflectionId)
    ? query?.reflectionId[0]
    : query?.reflectionId;
  const reflectionId = rawReflectionId?.trim();
  if (!reflectionId) redirect("/reflection");
  const rawSegment = Array.isArray(query?.segmentId) ? query?.segmentId[0] : query?.segmentId;
  const segment = rawSegment?.trim();
  redirect(`/reflection/sessions/${encodeURIComponent(reflectionId)}${segment
    ? `?segment=${encodeURIComponent(segment)}`
    : ""}`);
}
