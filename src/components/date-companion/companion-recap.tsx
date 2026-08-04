"use client";

import { useEffect, useMemo, useState } from "react";

import type {
  DateCompanionMutationState,
  DateCompanionParticipantRole,
  InteractionVM,
  ParticipantReviewVM,
  RecapItemVM,
  SourceRefVM,
  TranscriptLineVM
} from "@/lib/domain/date-companion";

import { CompanionTranscript, type TranscriptChapterPresentation } from "./companion-transcript";
import styles from "./date-companion.module.css";

export type CompanionParticipantMutation = {
  speakerId: string;
  role: DateCompanionParticipantRole;
};

export type CompanionRecapItemMutation = {
  id: string;
  version: number;
  userText: string | null;
  disposition: RecapItemVM["disposition"];
};

type CompanionRecapProps = {
  chapters?: TranscriptChapterPresentation[];
  initialSegmentId?: string | null;
  interaction: InteractionVM | null;
  items: RecapItemVM[];
  mutationState?: DateCompanionMutationState;
  participants?: ParticipantReviewVM[];
  onFinalize?: () => Promise<void> | void;
  onSaveParticipants?: (assignments: CompanionParticipantMutation[]) => Promise<void> | void;
  onSaveRecap?: (items: CompanionRecapItemMutation[]) => Promise<void> | void;
};

const GROUPS: Array<{ kind: RecapItemVM["kind"]; eyebrow: string; title: string; empty: string }> = [
  { kind: "moment", eyebrow: "01 · 一个瞬间", title: "这次值得记住", empty: "还没有找到带真实来源的特别片段" },
  { kind: "mentioned", eyebrow: "02 · Ta 提到的", title: "Ta 说起了什么", empty: "人物尚未核对，暂不把任何片段确定归给 Ta" },
  { kind: "promise", eyebrow: "03 · 你答应的", title: "这次出现的约定", empty: "还没有找到由“我”明确说出的约定" },
  { kind: "continue", eyebrow: "04 · 可以继续", title: "下次自然接上", empty: "还没有带来源的开放问题" }
];

const ROLE_OPTIONS: Array<{ role: DateCompanionParticipantRole; label: string }> = [
  { role: "self", label: "我" },
  { role: "companion", label: "Ta" },
  { role: "unresolved", label: "暂不确定" }
];

type RecapDraft = {
  text: string;
  disposition: RecapItemVM["disposition"];
};

function formatDuration(seconds?: number) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return null;
  const totalMinutes = Math.round(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours} 小时 ${minutes} 分钟` : `${minutes} 分钟`;
}

function formatTimestamp(seconds: number) {
  const whole = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(whole / 60);
  const remainder = whole % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function sourcePresentationLabel(source: SourceRefVM) {
  if (source.presentation === "direct_quote") return "原话片段";
  if (source.presentation === "suggestion") return "根据原话整理的建议";
  return "根据原话整理";
}

function speakerGroups(lines: TranscriptLineVM[]) {
  const groups = new Map<string, { id: string; label?: string; samples: string[] }>();
  for (const line of lines) {
    if (!line.speakerId) continue;
    const key = line.speakerId;
    const existing = groups.get(key) ?? { id: key, label: line.speakerLabel, samples: [] };
    if (!existing.label && line.speakerLabel) existing.label = line.speakerLabel;
    if (existing.samples.length < 3 && !existing.samples.includes(line.text)) existing.samples.push(line.text);
    groups.set(key, existing);
  }
  return [...groups.values()];
}

function RecapSourceList({
  availableSegmentIds,
  onJump,
  sources
}: {
  availableSegmentIds: ReadonlySet<string>;
  onJump: (segmentId: string) => void;
  sources: SourceRefVM[];
}) {
  return (
    <details className={styles.sourceDetails}>
      <summary><span>{sources.length} 个真实来源</span><span>展开来源</span></summary>
      <ul className={styles.sourceList}>
        {sources.map((source) => {
          const firstSegmentId = source.segmentIds.find((segmentId) => availableSegmentIds.has(segmentId));
          return (
            <li className={styles.sourceItem} key={source.id}>
              <blockquote>{source.presentation === "direct_quote" ? `“${source.quote}”` : source.quote}</blockquote>
              <div className={styles.sourceMeta}>
                <span>{sourcePresentationLabel(source)} · {formatTimestamp(source.startSeconds)}</span>
                {firstSegmentId ? (
                  <button className={styles.sourceJump} onClick={() => onJump(firstSegmentId)} type="button">在文字稿中查看</button>
                ) : <span className={styles.evidenceOnlyLabel}>已保留可核对原话</span>}
              </div>
            </li>
          );
        })}
      </ul>
    </details>
  );
}

function initialDrafts(items: RecapItemVM[]) {
  return Object.fromEntries(items.map((item) => [
    item.id,
    { text: item.displayedText || item.proposedText, disposition: item.disposition } satisfies RecapDraft
  ]));
}

function initialRoles(
  speakers: Array<{ id: string }>,
  participants: ParticipantReviewVM[]
): Record<string, DateCompanionParticipantRole> {
  const persisted = new Map(participants.map((participant) => [participant.speakerId, participant.role]));
  return Object.fromEntries(speakers.map((speaker) => [speaker.id, persisted.get(speaker.id) ?? "unresolved"]));
}

export function CompanionRecap({
  chapters,
  initialSegmentId,
  interaction,
  items,
  mutationState = { status: "idle" },
  participants = [],
  onFinalize,
  onSaveParticipants,
  onSaveRecap
}: CompanionRecapProps) {
  const [highlightedSegmentId, setHighlightedSegmentId] = useState<string | null>(initialSegmentId ?? null);
  const [drafts, setDrafts] = useState<Record<string, RecapDraft>>(() => initialDrafts(items));
  const [roles, setRoles] = useState<Record<string, DateCompanionParticipantRole>>({});
  const [localOperation, setLocalOperation] = useState<"participants" | "recap" | "finalize" | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const validItems = useMemo(() => items.filter((item) => item.sources.length > 0), [items]);
  const speakers = useMemo(() => speakerGroups(interaction?.transcript ?? []), [interaction?.transcript]);
  const unassignedTranscriptCount = useMemo(
    () => interaction?.transcript.filter((line) => !line.speakerId).length ?? 0,
    [interaction?.transcript]
  );
  const duration = formatDuration(interaction?.durationSeconds);
  const availableSegmentIds = useMemo(
    () => new Set(interaction?.transcript.map((line) => line.id) ?? []),
    [interaction?.transcript]
  );
  const itemSyncKey = items.map((item) => `${item.id}:${item.version ?? 0}:${item.disposition}:${item.displayedText}`).join("|");
  const participantSyncKey = participants.map((participant) => `${participant.speakerId}:${participant.role}:${participant.version ?? 0}`).join("|");

  useEffect(() => {
    setDrafts(initialDrafts(items));
  }, [itemSyncKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setRoles(initialRoles(speakers, participants));
  }, [interaction?.id, participantSyncKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const editable = Boolean(onSaveParticipants || onSaveRecap || onFinalize);
  const confirmed = interaction?.persistenceStatus === "confirmed";
  const participantsDirty = speakers.some((speaker) => {
    const persisted = participants.find((participant) => participant.speakerId === speaker.id)?.role ?? "unresolved";
    return (roles[speaker.id] ?? "unresolved") !== persisted;
  });
  const recapDirty = validItems.some((item) => {
    const draft = drafts[item.id];
    return Boolean(draft) && (
      draft.text.trim() !== (item.displayedText || item.proposedText).trim()
      || draft.disposition !== item.disposition
    );
  });
  const hasPending = validItems.some((item) => (drafts[item.id]?.disposition ?? item.disposition) === "pending");
  const hasKept = validItems.some((item) => (drafts[item.id]?.disposition ?? item.disposition) === "kept");
  const hasKeptItemWithInvalidSpeaker = validItems.some((item) => {
    const disposition = drafts[item.id]?.disposition ?? item.disposition;
    if (disposition !== "kept") return false;
    return item.sources.some((source) => {
      if (!source.speakerId) return true;
      const role = roles[source.speakerId] ?? "unresolved";
      if (role === "unresolved") return true;
      if (item.kind === "mentioned") return role !== "companion";
      if (item.kind === "promise") return role !== "self";
      return false;
    });
  });
  const saving = mutationState.status === "saving" || localOperation !== null;
  const mutationError = mutationState.status === "error" ? mutationState.message : null;
  const canFinalize = Boolean(onFinalize) && !confirmed && validItems.length > 0 && hasKept && !hasPending && !hasKeptItemWithInvalidSpeaker && !participantsDirty && !recapDirty && !saving;

  const jumpToSource = (segmentId: string) => {
    setHighlightedSegmentId(segmentId);
    const targetUrl = new URL(window.location.href);
    targetUrl.searchParams.set("segment", segmentId);
    targetUrl.hash = "full-transcript";
    window.history.replaceState(
      window.history.state,
      "",
      `${targetUrl.pathname}${targetUrl.search}${targetUrl.hash}`
    );
    requestAnimationFrame(() => document.getElementById("full-transcript")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  const runMutation = async (
    operation: "participants" | "recap" | "finalize",
    action: () => Promise<void> | void
  ) => {
    if (saving) return;
    setLocalOperation(operation);
    setLocalError(null);
    try {
      await action();
    } catch (error) {
      setLocalError(error instanceof Error && error.message.trim() ? error.message : "暂时没有保存成功，请稍后再试。");
    } finally {
      setLocalOperation(null);
    }
  };

  const saveParticipants = () => runMutation("participants", async () => {
    if (!onSaveParticipants) return;
    await onSaveParticipants(speakers.map((speaker) => ({
      speakerId: speaker.id,
      role: roles[speaker.id] ?? "unresolved"
    })));
  });

  const saveRecap = () => runMutation("recap", async () => {
    if (!onSaveRecap) return;
    const mutations = validItems.filter((item) => {
      const draft = drafts[item.id];
      return Boolean(draft) && (
        draft.text.trim() !== (item.displayedText || item.proposedText).trim()
        || draft.disposition !== item.disposition
      );
    }).map((item) => {
      const draft = drafts[item.id];
      const normalizedText = draft.text.trim();
      return {
        id: item.id,
        version: item.version ?? 0,
        userText: normalizedText === item.proposedText.trim() ? null : normalizedText,
        disposition: draft.disposition
      };
    });
    await onSaveRecap(mutations);
  });

  return (
    <div className={styles.twoColumnPage}>
      <header className={styles.stickyHero}>
        <span className={styles.heroMark} aria-hidden="true">记</span>
        <p>{interaction?.recordingDate ?? "这次相处"}</p>
        <h1>{interaction?.status === "ready" ? "这次相处，已经整理好了" : interaction?.status === "failed" ? "这次整理没有完成" : "这次相处，正在整理"}</h1>
        <span>{editable
          ? confirmed ? "这次复盘已经留下，来源和你的修改都会继续保留。" : "先核对说话人，再决定哪些内容值得留下。只有带原话来源的内容才能确认。"
          : "你可以核对来源，但不会在这里修改、排除或确认写入长期记录。"}</span>
        {interaction ? (
          <div className={styles.heroFile}>
            <small>本次录音</small>
            <b>{interaction.fileName}</b>
            <span>{[duration, interaction.status === "ready" ? "已整理" : interaction.status === "failed" ? "处理失败" : "正在处理"].filter(Boolean).join(" · ")}</span>
          </div>
        ) : null}
      </header>

      <div className={styles.contentColumn}>
        {!interaction ? (
          <section className={styles.contentPanel}>
            <h2>还没有一次相处记录</h2>
            <div className={styles.emptyState}><div><b>先上传一段录音</b><span>整理完成后，这里会显示有真实来源的复盘和文字稿。</span><a href="/date-companion/a">返回上传</a></div></div>
          </section>
        ) : interaction.status !== "ready" ? (
          <section className={styles.contentPanel}>
            <h2>{interaction.status === "failed" ? "处理失败" : "还在整理"}</h2>
            <p className={styles.contentIntro}>{interaction.status === "failed" ? "请返回首页查看服务端返回的错误；“重新读取”不会重新执行处理。" : `当前真实进度${typeof interaction.progress === "number" ? `为 ${Math.round(interaction.progress)}%` : "暂未返回"}。内容为空不代表最终没有内容。`}</p>
          </section>
        ) : (
          <>
            <div className={styles.processSteps} aria-label="本次录音整理阶段">
              <span><b>01</b>录音已上传</span>
              <span><b>02</b>已经转成文字</span>
              <span className={styles.processActive}><b>03</b>{confirmed ? "已确认留下" : editable ? "核对并确认" : "只读核对来源"}</span>
            </div>

            {(localError || mutationError) ? <p className={styles.inlineError} role="alert">{localError || mutationError}</p> : null}

            <section className={styles.contentPanel} aria-labelledby="participant-review-title">
              <h2 id="participant-review-title">这次录音里的说话人</h2>
              <p className={styles.contentIntro}>请由你确认“我”“Ta”或“暂不确定”。已有昵称和说话人编号都不会被当成人物身份。</p>
              {unassignedTranscriptCount > 0 ? (
                <p className={styles.boundaryNote} role="note">
                  有 {unassignedTranscriptCount} 段文字没有稳定的说话人标记，仍可在完整文字稿中查看，但不会被合并成一个虚构人物，也不能进入长期记录。
                </p>
              ) : null}
              {speakers.length > 0 ? (
                <div className={styles.participantList}>
                  {speakers.map((speaker, index) => (
                    <article className={styles.participantCard} key={speaker.id}>
                      <span className={styles.speakerMark} aria-hidden="true">{index + 1}</span>
                      <div className={styles.participantCopy}>
                        <b>{speaker.label?.trim() || `说话人 ${index + 1}`}</b>
                        <small>{speaker.label ? `本次录音昵称 · 原始编号 ${speaker.id}` : `原始编号 ${speaker.id}`}</small>
                        <ul className={styles.participantSamples}>
                          {speaker.samples.map((sample) => <li key={sample}>“{sample}”</li>)}
                        </ul>
                        {editable ? (
                          <div className={styles.participantRoleGroup} aria-label={`${speaker.label?.trim() || `说话人 ${index + 1}`}的身份`}>
                            {ROLE_OPTIONS.map((option) => (
                              <button
                                aria-pressed={(roles[speaker.id] ?? "unresolved") === option.role}
                                className={`${styles.roleChoice} ${(roles[speaker.id] ?? "unresolved") === option.role ? styles.roleChoiceActive : ""}`}
                                disabled={confirmed || saving}
                                key={option.role}
                                onClick={() => setRoles((current) => ({ ...current, [speaker.id]: option.role }))}
                                type="button"
                              >{option.label}</button>
                            ))}
                          </div>
                        ) : <span className={styles.readOnlyBadge}>尚未核对</span>}
                      </div>
                    </article>
                  ))}
                  {editable && !confirmed ? (
                    <button className={styles.secondaryButton} disabled={!participantsDirty || saving} onClick={saveParticipants} type="button">
                      {localOperation === "participants" || (mutationState.status === "saving" && mutationState.operation === "participants") ? "正在保存…" : "保存说话人判断"}
                    </button>
                  ) : null}
                </div>
              ) : <div className={styles.emptyState}><div><b>没有可核对的说话人</b><span>{unassignedTranscriptCount > 0 ? "这次文字稿没有稳定的说话人标记，因此暂不能确认人物归属。" : "文字稿中没有识别到可用内容。"}</span></div></div>}
            </section>

            <section className={styles.recapGrid} aria-label="这次相处复盘">
              {GROUPS.map((group) => {
                const groupItems = validItems.filter((item) => item.kind === group.kind);
                return (
                  <article className={styles.recapCard} key={group.kind}>
                    <span className={styles.recapNumber}>{group.eyebrow}</span>
                    <h3>{group.title}</h3>
                    {groupItems.length === 0 ? <p className={styles.recapText}>{group.empty}</p> : groupItems.map((item) => {
                      const draft = drafts[item.id] ?? { text: item.displayedText || item.proposedText, disposition: item.disposition };
                      return (
                        <div className={styles.recapItemEditor} data-disposition={draft.disposition} key={item.id}>
                          {editable ? (
                            <label className={styles.recapEditField}>
                              <span className={styles.visuallyHidden}>编辑“{group.title}”</span>
                              <textarea
                                aria-label={`编辑“${group.title}”`}
                                disabled={confirmed || saving}
                                onChange={(event) => setDrafts((current) => ({ ...current, [item.id]: { ...draft, text: event.target.value } }))}
                                value={draft.text}
                              />
                            </label>
                          ) : <p className={styles.recapText}>{draft.text}</p>}
                          {editable ? (
                            <div className={styles.recapDispositionActions}>
                              {draft.disposition === "excluded" ? (
                                <button disabled={confirmed || saving} onClick={() => setDrafts((current) => ({ ...current, [item.id]: { ...draft, disposition: "pending" } }))} type="button">恢复</button>
                              ) : (
                                <>
                                  <button
                                    aria-pressed={draft.disposition === "kept"}
                                    disabled={confirmed || saving}
                                    onClick={() => setDrafts((current) => ({ ...current, [item.id]: { ...draft, disposition: "kept" } }))}
                                    type="button"
                                  >留下</button>
                                  <button disabled={confirmed || saving} onClick={() => setDrafts((current) => ({ ...current, [item.id]: { ...draft, disposition: "excluded" } }))} type="button">不留下</button>
                                </>
                              )}
                              <span>{draft.disposition === "kept" ? "准备留下" : draft.disposition === "excluded" ? "不会进入长期记录" : "还没有决定"}</span>
                            </div>
                          ) : <span className={styles.readOnlyBadge}>只读 · 尚未写入长期记录</span>}
                          <RecapSourceList availableSegmentIds={availableSegmentIds} sources={item.sources} onJump={jumpToSource} />
                        </div>
                      );
                    })}
                  </article>
                );
              })}
            </section>

            {editable ? (
              <section className={styles.confirmRecapPanel} aria-labelledby="confirm-recap-title">
                <div>
                  <p className={styles.eyebrow}>由你决定</p>
                  <h2 id="confirm-recap-title">确认后，才会在以后见 Ta 前出现</h2>
                  <p>{confirmed
                    ? "这次复盘已经确认。被排除的内容不会出现在关于 Ta、搜索、准备或约定里。"
                    : hasKeptItemWithInvalidSpeaker ? "准备留下的内容仍有说话人尚未核对；“Ta 提到”必须来自 Ta，“你答应的”必须来自我。你也可以选择不留下该条。" : hasPending ? "请为每条带来源的内容选择“留下”或“不留下”。" : recapDirty ? "先保存本次修改，再做最终确认。" : "确认会保留你的修改和对应原话；重复确认不会产生重复约定。"}</p>
                </div>
                <div className={styles.confirmRecapActions}>
                  {!confirmed ? <button className={styles.secondaryButton} disabled={!recapDirty || saving} onClick={saveRecap} type="button">{localOperation === "recap" || (mutationState.status === "saving" && mutationState.operation === "recap") ? "正在保存…" : "保存本次修改"}</button> : null}
                  <button
                    className={styles.primaryButton}
                    disabled={!canFinalize}
                    onClick={() => onFinalize && void runMutation("finalize", onFinalize)}
                    type="button"
                  ><span>{confirmed ? "已经确认留下" : localOperation === "finalize" || (mutationState.status === "saving" && mutationState.operation === "finalize") ? "正在确认…" : "最终确认"}</span><span aria-hidden="true">✓</span></button>
                </div>
              </section>
            ) : null}

            {interaction.transcript.length > 0 ? (
              <CompanionTranscript chapters={chapters} highlightedSegmentId={highlightedSegmentId} lines={interaction.transcript} />
            ) : (
              <section className={styles.contentPanel}>
                <h2>可核对的原话</h2>
                <p className={styles.contentIntro}>这台设备没有完整文字稿；上面的来源片段仍会保留，不会生成点开后失效的入口。</p>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
