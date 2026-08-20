import { notFound } from "next/navigation";

import { DailyReflectionShell } from "@/components/daily-reflection/daily-reflection-shell";
import {
  isDailyReflectionBrowserRecordingEnabled,
  isDailyReflectionToySyncEnabled,
  isDailyReflectionUploadEnabled
} from "@/lib/server/daily-reflection/runtime-config";

type DailyReflectionPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function DailyReflectionPage({ searchParams }: DailyReflectionPageProps) {
  if (!isDailyReflectionUploadEnabled()) notFound();

  const rawReflectionId = (await searchParams)?.reflectionId;
  const initialReflectionId = typeof rawReflectionId === "string" && rawReflectionId.trim()
    ? rawReflectionId.trim()
    : null;

  return (
    <DailyReflectionShell
      browserRecordingEnabled={isDailyReflectionBrowserRecordingEnabled()}
      initialReflectionId={initialReflectionId}
      toySyncEnabled={isDailyReflectionToySyncEnabled()}
    />
  );
}
