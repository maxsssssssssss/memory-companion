import type { Metadata } from "next";

import { WorkProjectsPage } from "@/components/work-review/work-projects-page";

export const metadata: Metadata = { title: "项目 · 工作复盘" };

export default function WorkReviewProjectsPage() {
  return <WorkProjectsPage />;
}
