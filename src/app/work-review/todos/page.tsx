import { notFound } from "next/navigation";

import { WorkTodoListPage } from "@/components/work-review/work-todo-list";
import { isWorkReviewTodoEnabled } from "@/lib/server/work-review/runtime-config";

export default function WorkReviewTodosPage() {
  if (!isWorkReviewTodoEnabled()) notFound();
  return <WorkTodoListPage />;
}
