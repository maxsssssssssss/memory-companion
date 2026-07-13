import React from "react";
import { formatTime } from "@/lib/domain/time";
import type { BriefItem } from "@/lib/domain/types";

type EvidenceDrawerProps = {
  item: BriefItem;
  compact?: boolean;
};

export function EvidenceDrawer({ item, compact = false }: EvidenceDrawerProps) {
  const { sourceTimeRange, transcriptExcerpt } = item;
  const label = `证据 ${formatTime(sourceTimeRange.startSeconds)}-${formatTime(sourceTimeRange.endSeconds)}`;

  return React.createElement(
    "details",
    { className: compact ? "evidence-drawer evidence-drawer-compact" : "evidence-drawer" },
    React.createElement(
      "summary",
      null,
      compact ? `来源 ${formatTime(sourceTimeRange.startSeconds)}-${formatTime(sourceTimeRange.endSeconds)}` : label
    ),
    React.createElement("p", null, transcriptExcerpt)
  );
}
