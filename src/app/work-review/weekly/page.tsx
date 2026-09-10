import { Suspense } from "react";

import {
  WorkWeeklyPage,
  WorkWeeklyPageFallback
} from "@/components/work-review/work-weekly-page";

export default function WorkReviewWeeklyRoute() {
  return (
    <Suspense fallback={<WorkWeeklyPageFallback />}>
      <WorkWeeklyPage />
    </Suspense>
  );
}
