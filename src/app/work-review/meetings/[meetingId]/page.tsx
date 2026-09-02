import type { Metadata } from "next";

import { WorkMeetingDetail } from "@/components/work-review/work-meeting-detail";

export const metadata: Metadata = { title: "会议详情 · 工作复盘" };

export default async function WorkMeetingDetailPage({
  params
}: Readonly<{ params: Promise<{ meetingId: string }> }>) {
  const { meetingId } = await params;
  return <WorkMeetingDetail meetingId={meetingId} />;
}
