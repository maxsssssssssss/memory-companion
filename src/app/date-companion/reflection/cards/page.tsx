import { notFound } from "next/navigation";

import { DailyReflectionCardLibrary } from "@/components/daily-reflection/daily-reflection-card-library";
import { isDailyReflectionUploadEnabled } from "@/lib/server/daily-reflection/runtime-config";

export default function DailyReflectionCardsPage() {
  if (!isDailyReflectionUploadEnabled()) notFound();
  return <DailyReflectionCardLibrary />;
}
