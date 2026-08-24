import { notFound } from "next/navigation";

import { DailyReflectionReturn } from "@/components/daily-reflection/daily-reflection-return";
import { isDailyReflectionUploadEnabled } from "@/lib/server/daily-reflection/runtime-config";

export default function DailyReflectionReturnPage() {
  if (!isDailyReflectionUploadEnabled()) notFound();
  return <DailyReflectionReturn />;
}
