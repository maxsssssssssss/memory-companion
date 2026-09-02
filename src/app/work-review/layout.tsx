import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { WorkReviewShell } from "@/components/work-review/work-review-shell";
import { isDailyReflectionUploadEnabled } from "@/lib/server/daily-reflection/runtime-config";
import {
  isWorkReviewAnalysisEnabled,
  isWorkReviewEnabled,
  isWorkReviewFollowUpEnabled,
  isWorkReviewTodoEnabled,
  isWorkReviewTodoMeetingProjectionEnabled,
  isWorkReviewUploadEnabled,
  isWorkReviewVerifierEnabled
} from "@/lib/server/work-review/runtime-config";

export const metadata: Metadata = {
  title: "工作复盘 · Daily Brief",
  description: "上传工作会议录音，核对讨论、决定、承诺和行动事项。"
};

export const dynamic = "force-dynamic";

export default function WorkReviewLayout({ children }: Readonly<{ children: ReactNode }>) {
  if (!isWorkReviewEnabled()) notFound();
  return (
    <WorkReviewShell
      analysisEnabled={isWorkReviewAnalysisEnabled()}
      dailyReflectionEnabled={isDailyReflectionUploadEnabled()}
      followUpEnabled={isWorkReviewFollowUpEnabled()}
      uploadEnabled={isWorkReviewUploadEnabled()}
      todoEnabled={isWorkReviewTodoEnabled()}
      todoMeetingProjectionEnabled={isWorkReviewTodoMeetingProjectionEnabled()}
      verifierEnabled={isWorkReviewVerifierEnabled()}
    >
      {children}
    </WorkReviewShell>
  );
}
