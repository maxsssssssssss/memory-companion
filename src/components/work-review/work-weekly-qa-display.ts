import { useEffect, useMemo, useState } from "react";

import type { WorkReviewV2CoreApi, WorkWeeklyLiveSourceResponse } from "@/lib/client/work-review-api";
import type { WorkWeeklyQaMessage, WorkWeeklyReview, WorkWeeklySourceSnapshot } from "@/lib/domain/work-weekly";

const QUOTED_TEXT = /(“[^“”]*”|‘[^‘’]*’|「[^「」]*」|『[^『』]*』|《[^《》]*》|"[^"\r\n]*"|'[^'\r\n]*')/u;
const QUOTE_MARK = /[“”‘’「」『』《》"']/u;
const STATUS_TEXT = /(?:状态为[ \t]*(?:open|completed)|被标记为[ \t]+completed|标记[ \t]+completed[ \t]+后被重新打开为[ \t]+open)(?=[ \t]*(?:$|[。！？\r\n，；、）)]))/u;

export function hasWeeklyQaStatusText(text: string): boolean {
  return STATUS_TEXT.test(text) && !/[`~\[\]<>]|\w+:\/\//u.test(text)
    && !/^(?: {4}|\t|\s*#)/mu.test(text);
}

// Presentation only. Source types establish Todo context; literal titles are protected.
export function formatWeeklyQaDisplayText(text: string, sources: readonly WorkWeeklyLiveSourceResponse[] = []): string {
  if (!hasWeeklyQaStatusText(text) || sources.length === 0) return text;
  const titles: string[] = [];
  for (const response of sources) {
    if (!response.identity.included) return text;
    if (response.identity.sourceKind === "todo") {
      const source = response.source as WorkWeeklySourceSnapshot["todos"][number];
      if (source.current.deletedAt) return text;
      titles.push(source.current.title);
      if (source.stateAtWeekEnd) titles.push(source.stateAtWeekEnd.title);
    } else if (response.identity.sourceKind === "todo_event") {
      const source = response.source as WorkWeeklySourceSnapshot["todoEvents"][number];
      if (!source.stateAfter || source.stateAfter.deletedAt) return text;
      titles.push(source.stateAfter.title);
    } else return text; // Mixed source types do not establish a safe per-sentence mapping.
  }
  const quotedParts = text.split(QUOTED_TEXT);
  if (quotedParts.some((part, index) => index % 2
    ? /[。！？\r\n]/u.test(part) : QUOTE_MARK.test(part))) return text;
  const literals = [...new Set(titles)].filter(Boolean).sort((a, b) => b.length - a.length)
    .map((title) => title.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
  const protectedText = new RegExp(`(${[...literals, QUOTED_TEXT.source.slice(1, -1)].join("|")})`, "u");
  const parts = text.split(protectedText);
  // A label or mixed object can govern later sentences too; leave the whole answer alone.
  if (parts.some((part, index) => index % 2 === 0 && /标题|名称|原话|引文|引用|代码|链接|会议|项目|处理状态/u.test(part))) return text;
  return parts.map((part, index) => index % 2 ? part : part
    .split(/([。！？\r\n]+)/u).map((sentence) => {
      return sentence
        .replace(/((?:观察截止|当前(?:系统)?|系统)?状态为)[ \t]*(open|completed)(?=[ \t]*(?:$|[，；、）)]))/gu,
          (_, prefix: string, status: string) => prefix + (status === "open" ? "未完成" : "已标记完成"))
        .replace(/被标记为[ \t]+completed(?=[ \t]*(?:$|[，；、）)]))/gu, "被标记为已完成")
        .replace(/标记[ \t]+completed[ \t]+后被重新打开为[ \t]+open(?=[ \t]*(?:$|[，；、）)]))/gu,
          "标记完成后被重新打开为未完成");
    }).join("")
  ).join("");
}

type SourceEntry = { controller: AbortController; response: WorkWeeklyLiveSourceResponse | null; deadline: ReturnType<typeof setTimeout> };

// Ephemeral, scoped metadata only. The source dialog keeps its independent fresh-read path.
export function useWeeklyQaDisplayText(api: WorkReviewV2CoreApi | null, review: WorkWeeklyReview | null,
  threadId: string | undefined, messages: readonly WorkWeeklyQaMessage[], enabled: boolean) {
  const [, update] = useState(0);
  const cache = useMemo(() => new Map<string, SourceEntry>(), [api, review?.accountId, review?.id, review?.sourceSnapshotDigest, threadId]);
  const eligible = (message: WorkWeeklyQaMessage) => enabled && review?.status === "ready"
    && !review.deletedAt && message.accountId === review.accountId && message.weeklyReviewId === review.id
    && message.threadId === threadId && message.sourceSnapshotDigest === review.sourceSnapshotDigest
    && message.role === "assistant" && message.verifierProfile !== null && !message.invalidatedAt
    && (message.answerStatus === "answered" || message.answerStatus === "partially_answered")
    && message.text !== null && hasWeeklyQaStatusText(message.text);

  useEffect(() => () => {
    for (const entry of cache.values()) { entry.controller.abort(); clearTimeout(entry.deadline); }
    cache.clear();
  }, [cache]);

  useEffect(() => {
    const refs = new Set(messages.filter(eligible).flatMap((message) => message.sourceRefs));
    for (const [ref, entry] of cache) {
      if (!refs.has(ref)) { entry.controller.abort(); clearTimeout(entry.deadline); cache.delete(ref); }
    }
    if (!api || !review) return;
    for (const ref of refs) {
      if (cache.has(ref)) continue;
      const controller = new AbortController();
      const entry: SourceEntry = { controller, response: null, deadline: setTimeout(() => controller.abort(), 10_000) };
      cache.set(ref, entry);
      void api.getWeeklySource(review.id, ref, controller.signal).then((response) => {
        if (controller.signal.aborted || cache.get(ref) !== entry) return;
        if (response.identity.sourceRef === ref && "sourceRef" in response.source && response.source.sourceRef === ref) entry.response = response;
        update((revision) => revision + 1);
      }).catch(() => { /* Metadata failure leaves the original answer visible; no automatic retry. */ })
        .finally(() => clearTimeout(entry.deadline));
    }
  }, [api, cache, messages, enabled, review, threadId]);

  return (message: WorkWeeklyQaMessage) => {
    if (!eligible(message) || message.sourceRefs.length === 0) return message.text;
    const sources = message.sourceRefs.map((ref) => cache.get(ref)?.response);
    return sources.every((source): source is WorkWeeklyLiveSourceResponse => Boolean(source))
      ? formatWeeklyQaDisplayText(message.text!, sources) : message.text;
  };
}
