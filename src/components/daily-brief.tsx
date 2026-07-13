"use client";

import { type FormEvent, useEffect, useState } from "react";

import { formatTime } from "@/lib/domain/time";
import { replaceSpeakerIdsForUpload, speakerAliasForUpload } from "@/lib/domain/speaker-aliases";
import type { AtmosphereLabel, AudioInsight, BriefCategory, BriefItem, EmotionEvidenceSource, RelationshipSignalCard } from "@/lib/domain/types";

import { EvidenceDrawer } from "./evidence-drawer";
import { RelationshipSignalCards } from "./relationship-signal-cards";

const categoryLabels: Record<BriefCategory, string> = {
  commitment: "承诺",
  task: "待办",
  decision: "决策",
  idea: "灵感",
  risk: "风险",
  open_question: "未决问题",
  notable_quote: "重要原话"
};

const priorityRank: Record<BriefItem["priority"], number> = {
  high: 0,
  medium: 1,
  low: 2
};

const atmosphereLabels: Record<AtmosphereLabel, string> = {
  focused: "专注",
  serious: "认真",
  tense: "偏紧",
  warm: "温和",
  playful: "轻松",
  awkward: "尴尬",
  rushed: "赶时间",
  uncertain: "不确定",
  collaborative: "协作",
  conflicted: "有分歧",
  avoidant: "回避",
  unknown: "未知"
};

const emotionEvidenceSourceLabels: Record<EmotionEvidenceSource, string> = {
  transcript: "原文",
  acoustic: "声音",
  llm: "AI",
  user_correction: "用户纠正",
  fusion: "融合"
};

type DailyBriefProps = {
  items: BriefItem[];
  audioInsights?: AudioInsight[];
  relationshipSignals?: RelationshipSignalCard[];
  transcriptSegmentCount?: number;
  speakerAliasTargets?: Array<{ uploadId: string; speakerId: string }>;
  speakerAliasesByUploadId?: Record<string, Record<string, string>>;
  onSaveSpeakerAliases?: (aliasesByUploadId: Record<string, Record<string, string>>) => Promise<void>;
};

function byPriorityThenTime(a: BriefItem, b: BriefItem) {
  return priorityRank[a.priority] - priorityRank[b.priority] || a.sourceTimeRange.startSeconds - b.sourceTimeRange.startSeconds;
}

function firstToken(value: string) {
  return Array.from(value.trim())[0] ?? "记";
}

function aggregatePeople(items: BriefItem[]) {
  const counts = new Map<string, number>();

  items.forEach((item) => {
    item.people.forEach((person) => {
      counts.set(person, (counts.get(person) ?? 0) + 1);
    });
  });

  return Array.from(counts.entries())
    .sort(([, aCount], [, bCount]) => bCount - aCount)
    .slice(0, 5);
}

function aggregateAtmosphereLabels(audioInsights: AudioInsight[]) {
  const counts = new Map<AtmosphereLabel, number>();

  audioInsights.forEach((insight) => {
    (insight.atmosphereLabels ?? []).forEach((label) => {
      if (label === "unknown") {
        return;
      }

      counts.set(label, (counts.get(label) ?? 0) + 1);
    });
  });

  return Array.from(counts.entries())
    .sort(([, aCount], [, bCount]) => bCount - aCount)
    .slice(0, 5);
}

function topEmotionEvidence(audioInsights: AudioInsight[]) {
  return audioInsights
    .flatMap((insight) => (insight.emotionEvidence ?? []).map((evidence) => ({ insight, evidence })))
    .sort((a, b) => b.evidence.confidence - a.evidence.confidence || a.evidence.sourceTimeRange.startSeconds - b.evidence.sourceTimeRange.startSeconds)
    .slice(0, 3);
}

function EmptySection({ text }: { text: string }) {
  return <p className="panel-empty section-empty">{text}</p>;
}

function EmptyBriefOverview({ transcriptSegmentCount }: { transcriptSegmentCount: number }) {
  if (transcriptSegmentCount > 0) {
    return (
      <div className="empty-brief-overview">
        <p>已完成转写，但没有提取到简报条目。</p>
        <p>可以切到时间轴查看原文片段，或换一种问法在问答里追问。</p>
      </div>
    );
  }

  return (
    <div className="empty-brief-overview">
      <p>没有识别到可用文字。</p>
      <p>可能是录音里没有清晰人声、音量过低或过载，或转写服务返回了空结果。</p>
    </div>
  );
}

function SpeakerAliasEditor({
  speakerAliasTargets,
  speakerAliasesByUploadId,
  onSave
}: {
  speakerAliasTargets: Array<{ uploadId: string; speakerId: string }>;
  speakerAliasesByUploadId: Record<string, Record<string, string>>;
  onSave?: (aliasesByUploadId: Record<string, Record<string, string>>) => Promise<void>;
}) {
  const [draftAliases, setDraftAliases] = useState<Record<string, Record<string, string>>>(speakerAliasesByUploadId);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const hasMultipleUploads = new Set(speakerAliasTargets.map((target) => target.uploadId)).size > 1;
  const aliasTargetKey = speakerAliasTargets.map((target) => `${target.uploadId}:${target.speakerId}`).join("|");

  useEffect(() => {
    setDraftAliases(speakerAliasesByUploadId);
  }, [speakerAliasesByUploadId]);

  useEffect(() => {
    setSaveState("idle");
  }, [aliasTargetKey]);

  async function submitAliases(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!onSave || speakerAliasTargets.length === 0) {
      return;
    }

    setSaveState("saving");

    try {
      await onSave(draftAliases);
      setSaveState("saved");
    } catch {
      setSaveState("error");
    }
  }

  if (speakerAliasTargets.length === 0) {
    return <EmptySection text="当前录音没有识别到 speaker 标签。" />;
  }

  return (
    <form className="speaker-alias-form" onSubmit={submitAliases}>
      {speakerAliasTargets.map(({ uploadId, speakerId }) => (
        <label key={`${uploadId}:${speakerId}`} className="speaker-alias-row">
          <span>{hasMultipleUploads ? `${uploadId.slice(0, 8)} · ${speakerId}` : speakerId}</span>
          <input
            value={draftAliases[uploadId]?.[speakerId] ?? ""}
            placeholder={speakerId}
            onChange={(event) =>
              setDraftAliases((current) => ({
                ...current,
                [uploadId]: {
                  ...(current[uploadId] ?? {}),
                  [speakerId]: event.target.value
                }
              }))
            }
          />
        </label>
      ))}
      <div className="speaker-alias-actions">
        <button type="submit" className="ghost-button" disabled={!onSave || saveState === "saving"}>
          {saveState === "saving" ? "保存中" : "保存"}
        </button>
        {saveState === "saved" ? <span>已保存</span> : null}
        {saveState === "error" ? <span className="form-error">保存失败</span> : null}
      </div>
    </form>
  );
}

function BriefList({
  items,
  variant
}: {
  items: BriefItem[];
  variant: "decision" | "idea";
}) {
  if (items.length === 0) {
    return <EmptySection text={variant === "decision" ? "暂无关键决策。" : "暂无灵感、未决问题或重要原话。"} />;
  }

  return (
    <div className="card list">
      {items.map((item) => (
        <article key={item.id} className="li">
          <div className={`mk mk-${variant}`} aria-hidden="true">
            {variant === "decision" ? "✓" : "•"}
          </div>
          <div className="li-main">
            <p>
              <strong>{item.title}</strong>
              <span>{item.body}</span>
            </p>
            <EvidenceDrawer item={item} />
          </div>
          <span className="t">{categoryLabels[item.category]}</span>
        </article>
      ))}
    </div>
  );
}

export function DailyBrief({
  items,
  audioInsights = [],
  relationshipSignals = [],
  transcriptSegmentCount = 0,
  speakerAliasTargets = [],
  speakerAliasesByUploadId = {},
  onSaveSpeakerAliases
}: DailyBriefProps) {
  const actionItems = items.filter((item) => item.category === "commitment" || item.category === "task").sort(byPriorityThenTime);
  const decisions = items.filter((item) => item.category === "decision").sort(byPriorityThenTime);
  const ideas = items
    .filter((item) => item.category === "idea" || item.category === "open_question" || item.category === "notable_quote")
    .sort(byPriorityThenTime);
  const risks = items.filter((item) => item.category === "risk").sort(byPriorityThenTime);
  const highPriorityCount = items.filter((item) => item.priority === "high").length;
  const people = aggregatePeople(items);
  const atmosphereCounts = aggregateAtmosphereLabels(audioInsights);
  const emotionEvidence = topEmotionEvidence(audioInsights);
  const hasAtmosphereEvidence = atmosphereCounts.length > 0 || emotionEvidence.length > 0;

  return (
    <div className="wrap brief-wrap">
      <header className="masthead anim">
        <div className="kicker">
          每日简报 · DAILY BRIEF
          <div className="rule" />
        </div>
        <h1>
          今天提取到 {decisions.length} 个决策、<br />
          {actionItems.length} 项<span className="accent-word">承诺 / 待办</span>。
        </h1>
        <div className="meta-row">
          <span className="m">
            <b>{items.length}</b> 条简报
          </span>
          <span className="sep" />
          <span className="m">
            <b>{highPriorityCount}</b> 条高优先级
          </span>
          <span className="sep" />
          <span className="m">
            <b>{risks.length}</b> 条风险
          </span>
        </div>
      </header>

      <div className="grid">
        <div>
          <div className="card overview anim">
            <div className="lead">今日概览</div>
            {items.length > 0 ? (
              <p>
                本次录音提取到 <strong>{items.length}</strong> 条可追溯信息，其中 <strong>{actionItems.length}</strong>{" "}
                条承诺 / 待办、<strong>{decisions.length}</strong> 条决策、<strong>{ideas.length}</strong> 条灵感与问题、
                <strong>{risks.length}</strong> 条风险。每一项都可以展开来源，回到对应的转写片段。
              </p>
            ) : (
              <EmptyBriefOverview transcriptSegmentCount={transcriptSegmentCount} />
            )}
          </div>

          <RelationshipSignalCards cards={relationshipSignals} speakerAliasesByUploadId={speakerAliasesByUploadId} />

          <section className="sec anim" aria-labelledby="actions-title">
            <div className="sec-head">
              <div className="ic ic-rust" aria-hidden="true">
                ✓
              </div>
              <h2 id="actions-title">我答应了谁什么</h2>
              <span className="ct">{actionItems.length} 项</span>
            </div>

            {actionItems.length > 0 ? (
              <div className="promise-list">
                {actionItems.map((item) => (
                  <article key={item.id} className="promise">
                    <div className="pav">{firstToken(item.people[0] ?? item.title)}</div>
                    <div className="body">
                      <div className="who">
                        {categoryLabels[item.category]} · <b>{item.people.join("、") || "未标注对象"}</b>
                      </div>
                      <h3 className="what">{item.title}</h3>
                      <p className="brief-body">{item.body}</p>
                      <div className="foot">
                        <span className={`chip priority priority-${item.priority}`}>{item.priority}</span>
                        {item.topics.slice(0, 3).map((topic) => (
                          <span key={topic} className="chip tag">
                            {topic}
                          </span>
                        ))}
                        <EvidenceDrawer item={item} compact />
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <EmptySection text="暂无承诺或待办。" />
            )}
          </section>

          <section className="sec anim" aria-labelledby="decisions-title">
            <div className="sec-head">
              <div className="ic ic-sage" aria-hidden="true">
                ✓
              </div>
              <h2 id="decisions-title">关键决策</h2>
              <span className="ct">{decisions.length} 项</span>
            </div>
            <BriefList items={decisions} variant="decision" />
          </section>

          <section className="sec anim" aria-labelledby="ideas-title">
            <div className="sec-head">
              <div className="ic ic-gold" aria-hidden="true">
                i
              </div>
              <h2 id="ideas-title">灵感与想法</h2>
              <span className="ct">{ideas.length} 条</span>
            </div>
            <BriefList items={ideas} variant="idea" />
          </section>
        </div>

        <aside className="right-rail" aria-label="简报侧栏">
          <section className="card rcard anim">
            <h3>今日数据</h3>
            <div className="stats">
              <div className="stat">
                <b>{items.length}</b>
                <span>简报条目</span>
              </div>
              <div className="stat">
                <b>{actionItems.length}</b>
                <span>承诺 / 待办</span>
              </div>
              <div className="stat">
                <b>{decisions.length}</b>
                <span>关键决策</span>
              </div>
              <div className="stat">
                <b>{people.length}</b>
                <span>人物提及</span>
              </div>
            </div>
          </section>

          <section className="card rcard anim">
            <h3>今日关键人物</h3>
            {people.length > 0 ? (
              people.map(([person, count]) => (
                <div key={person} className="person">
                  <div className="av">{firstToken(person)}</div>
                  <div className="pi">
                    <b>{person}</b>
                    <span>简报中提及</span>
                  </div>
                  <span className="n">x{count}</span>
                </div>
              ))
            ) : (
              <EmptySection text="暂无人物提及。" />
            )}
          </section>

          {hasAtmosphereEvidence ? (
            <section className="card rcard anim atmosphere-rail">
              <h3>今日互动气氛</h3>
              <>
                {atmosphereCounts.length > 0 ? (
                  <div className="atmosphere-chips" aria-label="今日气氛标签">
                    {atmosphereCounts.map(([label, count]) => (
                      <span key={label} className="chip tag tag-atmosphere">
                        {atmosphereLabels[label]} x{count}
                      </span>
                    ))}
                  </div>
                ) : null}
                {emotionEvidence.length > 0 ? (
                  <div className="atmosphere-evidence-list">
                    {emotionEvidence.map(({ insight, evidence }) => (
                      <article key={evidence.id} className="atmosphere-evidence">
                        <div>
                          <b>{evidence.label}</b>
                          <span>
                            {formatTime(evidence.sourceTimeRange.startSeconds)}-{formatTime(evidence.sourceTimeRange.endSeconds)} ·{" "}
                            {emotionEvidenceSourceLabels[evidence.source]} · {Math.round(evidence.confidence * 100)}%
                          </span>
                        </div>
                        <p>{replaceSpeakerIdsForUpload(insight.uploadId, evidence.detail, speakerAliasesByUploadId)}</p>
                        <small>{speakerAliasForUpload(insight.uploadId, insight.speaker.id, speakerAliasesByUploadId) ?? insight.speaker.displayName ?? insight.speaker.id}</small>
                      </article>
                    ))}
                  </div>
                ) : (
                  <EmptySection text="本次暂未生成可解释的气氛证据。" />
                )}
                <p className="atmosphere-note">这些只作为复盘线索，需要和原文一起看，不代表心理诊断。</p>
              </>
            </section>
          ) : null}

          <section className="card rcard anim">
            <h3>说话人名称</h3>
            <SpeakerAliasEditor speakerAliasTargets={speakerAliasTargets} speakerAliasesByUploadId={speakerAliasesByUploadId} onSave={onSaveSpeakerAliases} />
          </section>

          <section className="card rcard anim">
            <h3>待跟进 · 风险</h3>
            {risks.length > 0 ? (
              risks.map((item) => (
                <article key={item.id} className={`risk ${item.priority === "high" ? "hi" : ""}`}>
                  <div className="d" />
                  <div>
                    <p>
                      <strong>{item.title}</strong>
                      {item.body}
                    </p>
                    <EvidenceDrawer item={item} compact />
                  </div>
                </article>
              ))
            ) : (
              <EmptySection text="暂无风险条目。" />
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}
