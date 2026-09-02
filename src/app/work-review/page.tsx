import { WorkReviewHome } from "@/components/work-review/work-review-home";
import { WorkReviewToday } from "@/components/work-review/work-review-today";
import { isWorkReviewTodoEnabled } from "@/lib/server/work-review/runtime-config";

export default function WorkReviewPage() {
  return isWorkReviewTodoEnabled() ? <WorkReviewToday /> : <WorkReviewHome />;
}
