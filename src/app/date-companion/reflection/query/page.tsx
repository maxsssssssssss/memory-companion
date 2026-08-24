import { notFound } from "next/navigation";

import { DailyReflectionQuery } from "@/components/daily-reflection/daily-reflection-query";
import { isDailyReflectionUploadEnabled } from "@/lib/server/daily-reflection/runtime-config";

export default function DailyReflectionQueryPage() {
  if (!isDailyReflectionUploadEnabled()) notFound();
  return <DailyReflectionQuery />;
}
