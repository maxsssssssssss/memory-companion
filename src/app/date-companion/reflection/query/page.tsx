import { notFound, redirect } from "next/navigation";
import { isDailyReflectionUploadEnabled } from "@/lib/server/daily-reflection/runtime-config";

export default function DailyReflectionQueryPage() {
  if (!isDailyReflectionUploadEnabled()) notFound();
  redirect("/reflection/ask");
}
