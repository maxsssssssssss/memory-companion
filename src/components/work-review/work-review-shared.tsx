import type { WorkMeetingListItem } from "@/lib/client/work-review-api";

import styles from "./work-review.module.css";

const STATUS_LABELS: Readonly<Record<string, string>> = {
  created: "准备上传",
  queued: "等待处理",
  transcribing: "正在转写",
  transcript_ready: "原文已就绪",
  extracting: "正在整理",
  verifying: "正在核对",
  review_ready: "待确认",
  failed: "处理未完成",
  completed: "已完成"
};

export function meetingStatusLabel(meeting: Pick<WorkMeetingListItem, "analysisStatus" | "ingestionStatus" | "reviewStatus">) {
  if (meeting.reviewStatus === "completed") return STATUS_LABELS.completed;
  if (meeting.analysisStatus === "review_ready") return STATUS_LABELS.review_ready;
  if (meeting.analysisStatus === "failed" || meeting.ingestionStatus === "failed") return STATUS_LABELS.failed;
  if (meeting.analysisStatus !== "not_started") return STATUS_LABELS[meeting.analysisStatus] ?? "正在处理";
  return STATUS_LABELS[meeting.ingestionStatus] ?? "正在处理";
}

export function WorkMeetingStatus({ meeting }: Readonly<{
  meeting: Pick<WorkMeetingListItem, "analysisStatus" | "ingestionStatus" | "reviewStatus">;
}>) {
  const label = meetingStatusLabel(meeting);
  const tone = meeting.analysisStatus === "failed" || meeting.ingestionStatus === "failed"
    ? "error"
    : meeting.reviewStatus === "completed"
      ? "complete"
      : "status";
  return <span className={styles.statusBadge} data-tone={tone}><span aria-hidden="true" />{label}</span>;
}

export function formatMeetingDuration(seconds?: number | null) {
  if (seconds === undefined || seconds === null) return null;
  const rounded = Math.max(0, Math.round(seconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor(rounded % 3600 / 60);
  if (hours > 0) return `${hours} 小时 ${minutes} 分钟`;
  return `${Math.max(1, minutes)} 分钟`;
}

export function formatEvidenceTime(startSeconds: number, endSeconds?: number) {
  const format = (value: number) => {
    const seconds = Math.max(0, Math.floor(value));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor(seconds % 3600 / 60);
    const rest = seconds % 60;
    return hours > 0
      ? `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`
      : `${minutes}:${String(rest).padStart(2, "0")}`;
  };
  return endSeconds === undefined ? format(startSeconds) : `${format(startSeconds)}–${format(endSeconds)}`;
}
