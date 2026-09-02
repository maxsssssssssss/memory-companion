import { GlobalProductEntryBoundary } from "@/components/product-system/global-product-entry-boundary";
import { isDailyReflectionUploadEnabled } from "@/lib/server/daily-reflection/runtime-config";
import { isWorkReviewEnabled } from "@/lib/server/work-review/runtime-config";

export default function GlobalProductEntryPage() {
  return (
    <GlobalProductEntryBoundary
      dailyReflectionEnabled={isDailyReflectionUploadEnabled()}
      workReviewEnabled={isWorkReviewEnabled()}
    />
  );
}
