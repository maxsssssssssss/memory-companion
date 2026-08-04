"use client";

import { type FormEvent, useState } from "react";

import type {
  DateCompanionMutationState,
  DateCompanionSearchState,
  InteractionVM,
  PersonVM,
  PromiseVM,
  RecapItemVM,
  RelationshipVM,
  SourceRefVM
} from "@/lib/domain/date-companion";

import styles from "./date-companion.module.css";

type ProfileSection = {
  id: "remembered" | "recent" | "relationship" | "promises";
  eyebrow: string;
  title: string;
  empty: string;
};

type CompanionPersonProps = {
  currentInteraction: InteractionVM | null;
  relationship: RelationshipVM | null;
  person?: PersonVM;
  searchState?: DateCompanionSearchState;
  mutationState?: DateCompanionMutationState;
  onDeleteInteraction?: (interaction: InteractionVM) => Promise<void> | void;
  onOpenInteraction?: (interaction: InteractionVM) => Promise<void> | void;
  onOpenSource?: (source: SourceRefVM, segmentId: string) => Promise<void> | void;
  onSearch?: (query: string) => Promise<void> | void;
  onUpdatePromise?: (promise: PromiseVM, status: PromiseVM["status"]) => Promise<void> | void;
};

const PROFILE_SECTIONS: ProfileSection[] = [
  { id: "remembered", eyebrow: "记得的片段", title: "你记得的 Ta", empty: "还没有留下这一类片段" },
  { id: "recent", eyebrow: "最近提到", title: "Ta 最近", empty: "还没有留下这一类片段" },
  { id: "relationship", eyebrow: "相处片段", title: "你们之间", empty: "还没有经过你确认、且有原话来源的内容" },
  { id: "promises", eyebrow: "明确约定", title: "你答应了", empty: "还没有确认由“我”说出的约定" }
];

const EMPTY_PERSON: PersonVM = {
  remembered: [],
  recent: [],
  relationship: [],
  promises: [],
  interactions: [],
  observation: null,
  limitedToCurrentInteraction: true
};

function formatDate(recordingDate: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(recordingDate);
  return match ? `${Number(match[2])} 月 ${Number(match[3])} 日` : recordingDate;
}

function sourceTime(source: SourceRefVM) {
  const seconds = Math.max(0, Math.floor(source.startSeconds));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function EvidenceList({
  onOpenSource,
  sources
}: {
  onOpenSource?: (source: SourceRefVM, segmentId: string) => Promise<void> | void;
  sources: SourceRefVM[];
}) {
  return (
    <details className={styles.longTermSources}>
      <summary>核对原话 · {sources.length}</summary>
      <ul>
        {sources.map((source) => {
          const segmentId = source.segmentIds[0];
          const canOpen = Boolean(source.canOpenTranscript && segmentId && onOpenSource);
          return (
            <li key={source.id}>
              <blockquote>“{source.quote}”</blockquote>
              <div>
                <span>{formatDate(source.recordingDate)} · {sourceTime(source)}</span>
                {canOpen ? (
                  <button onClick={() => onOpenSource?.(source, segmentId)} type="button">在完整文字稿中查看</button>
                ) : <small>已保留可核对原话</small>}
              </div>
            </li>
          );
        })}
      </ul>
    </details>
  );
}

function RecapItems({
  empty,
  items,
  onOpenSource
}: {
  empty: string;
  items: RecapItemVM[];
  onOpenSource?: (source: SourceRefVM, segmentId: string) => Promise<void> | void;
}) {
  const kept = items.filter((item) => item.disposition === "kept" && item.sources.length > 0);
  if (kept.length === 0) return <p className={styles.profileEmpty}>{empty}</p>;
  return (
    <ul className={styles.profileFactList}>
      {kept.map((item) => (
        <li key={item.id}>
          <p>{item.displayedText || item.proposedText}</p>
          <EvidenceList onOpenSource={onOpenSource} sources={item.sources} />
        </li>
      ))}
    </ul>
  );
}

function PromiseList({
  empty,
  onOpenSource,
  onUpdatePromise,
  promises
}: {
  empty: string;
  onOpenSource?: (source: SourceRefVM, segmentId: string) => Promise<void> | void;
  onUpdatePromise?: (promise: PromiseVM, status: PromiseVM["status"]) => Promise<void> | void;
  promises: PromiseVM[];
}) {
  const [changingId, setChangingId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  if (promises.length === 0) return <p className={styles.profileEmpty}>{empty}</p>;
  return (
    <div>
      {errorMessage ? <p className={styles.inlineError} role="alert">{errorMessage}</p> : null}
      <ul className={styles.promiseList}>
        {promises.map((promise) => (
          <li key={promise.id}>
            <div className={styles.promiseHeading}>
              <p>{promise.text}</p>
              <span data-status={promise.status}>{promise.status === "open" ? "待完成" : "已完成"}</span>
            </div>
            <EvidenceList onOpenSource={onOpenSource} sources={promise.sources} />
            {onUpdatePromise ? (
              <button
                className={styles.promiseAction}
                disabled={changingId !== null}
                onClick={async () => {
                  setChangingId(promise.id);
                  setErrorMessage(null);
                  try {
                    await onUpdatePromise(promise, promise.status === "open" ? "done" : "open");
                  } catch (error) {
                    setErrorMessage(error instanceof Error && error.message.trim() ? error.message : "约定状态暂时没有保存成功。");
                  } finally {
                    setChangingId(null);
                  }
                }}
                type="button"
              >{changingId === promise.id ? "正在保存…" : promise.status === "open" ? "标为已完成" : "恢复为待完成"}</button>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function CompanionPerson({
  currentInteraction,
  onDeleteInteraction,
  onOpenInteraction,
  onOpenSource,
  onSearch,
  onUpdatePromise,
  person = EMPTY_PERSON,
  relationship,
  mutationState = { status: "idle" },
  searchState = { status: "idle" }
}: CompanionPersonProps) {
  const [expandedSection, setExpandedSection] = useState<ProfileSection["id"] | null>(null);
  const [query, setQuery] = useState("");
  const [deleteCandidateId, setDeleteCandidateId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const displayName = relationship?.displayName?.trim() || "Ta";
  const confirmedInteractions = person.interactions.filter((interaction) => interaction.persistenceStatus === "confirmed");
  const relationshipMutationError = mutationState.status === "error"
    && (mutationState.operation === "promise" || mutationState.operation === "delete")
    ? mutationState.message
    : null;

  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalized = query.trim();
    if (normalized && onSearch) void onSearch(normalized);
  };

  const sectionContent = (section: ProfileSection) => {
    if (section.id === "promises") {
      return (
        <PromiseList
          empty={section.empty}
          onOpenSource={onOpenSource}
          onUpdatePromise={onUpdatePromise}
          promises={person.promises}
        />
      );
    }
    return <RecapItems empty={section.empty} items={person[section.id]} onOpenSource={onOpenSource} />;
  };

  return (
    <div className={styles.twoColumnPage}>
      <header className={styles.stickyHero}>
        <span className={styles.heroMark} aria-hidden="true">Ta</span>
        <p>当前这段关系</p>
        <h1>{displayName}</h1>
        <span>这里只留下你亲自确认、并且能核对原话的内容。说话人编号和昵称不会替你判断谁是 Ta。</span>
      </header>

      <div className={styles.contentColumn}>
        <div className={styles.boundaryNote} role="note">
          被排除、尚未决定或说话人仍不确定的内容，不会出现在这里，也不会进入见面前准备和关键词搜索。
        </div>
        {relationshipMutationError ? <p className={styles.inlineError} role="alert">{relationshipMutationError}</p> : null}

        <section
          aria-label="关于 Ta 的四类内容"
          className={styles.profileGrid}
          data-expanded={expandedSection ?? undefined}
        >
          {PROFILE_SECTIONS.map((section) => {
            const expanded = expandedSection === section.id;
            const compact = expandedSection !== null && !expanded;
            return (
              <article
                className={`${styles.profileCard} ${expanded ? styles.profileCardExpanded : ""} ${compact ? styles.profileCardCompact : ""}`}
                data-card-state={expanded ? "expanded" : compact ? "compact" : "idle"}
                key={section.id}
              >
                <div className={styles.profileCardHeading}>
                  <div><small>{section.eyebrow}</small><h2>{section.title}</h2></div>
                  <button
                    aria-expanded={expanded}
                    aria-label={expanded ? `收起${section.title}` : `放大${section.title}`}
                    onClick={() => setExpandedSection(expanded ? null : section.id)}
                    type="button"
                  >{expanded ? "收起" : "细看"}</button>
                </div>
                {sectionContent(section)}
              </article>
            );
          })}
        </section>

        <section className={styles.contentPanel}>
          <h2>一起走过的几次</h2>
          <p className={styles.contentIntro}>只有最终确认过的相处会留在这里。</p>
          {deleteError ? <p className={styles.inlineError} role="alert">{deleteError}</p> : null}
          {confirmedInteractions.length === 0 ? (
            <div className={styles.emptyState}>
              <div><b>还没有确认过的相处</b><span>{currentInteraction?.status === "ready" ? "当前这次可以先在复盘页核对和确认。" : "上传一段重要对话，整理后由你决定是否留下。"}</span></div>
            </div>
          ) : (
            <ol className={styles.interactionHistory}>
              {confirmedInteractions.map((interaction) => {
                const canOpen = interaction.transcript.length > 0 && Boolean(onOpenInteraction);
                return (
                  <li key={interaction.id}>
                    <time dateTime={interaction.recordingDate}>{formatDate(interaction.recordingDate)}</time>
                    <div><b>{interaction.title || interaction.fileName}</b><span>{interaction.fileName}</span></div>
                    <div className={styles.interactionActions}>
                      {canOpen ? <button onClick={() => onOpenInteraction?.(interaction)} type="button">查看完整复盘</button> : <small>可核对原话已保留</small>}
                      {onDeleteInteraction ? (
                        <button
                          className={styles.removeInteractionAction}
                          disabled={deletingId !== null}
                          onClick={() => {
                            setDeleteError(null);
                            setDeleteCandidateId(interaction.id);
                          }}
                          type="button"
                        >移除这次记录</button>
                      ) : null}
                    </div>
                    {deleteCandidateId === interaction.id ? (
                      <div className={styles.removeInteractionConfirm} role="alertdialog" aria-label={`移除${formatDate(interaction.recordingDate)}的记录`}>
                        <p>移除后，这次相处留下的片段和由它产生的约定会一并重新整理。此操作不能在这里撤销。</p>
                        <div>
                          <button disabled={deletingId !== null} onClick={() => setDeleteCandidateId(null)} type="button">先不移除</button>
                          <button
                            disabled={deletingId !== null}
                            onClick={async () => {
                              setDeletingId(interaction.id);
                              setDeleteError(null);
                              try {
                                await onDeleteInteraction?.(interaction);
                                setDeleteCandidateId(null);
                              } catch (error) {
                                setDeleteError(error instanceof Error && error.message.trim() ? error.message : "这次记录暂时没有移除成功。");
                              } finally {
                                setDeletingId(null);
                              }
                            }}
                            type="button"
                          >{deletingId === interaction.id ? "正在移除…" : "确认移除"}</button>
                        </div>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          )}
        </section>

        <section className={styles.contentPanel} aria-labelledby="relationship-search-title">
          <h2 id="relationship-search-title">在这段关系里找一找</h2>
          <p className={styles.contentIntro}>只搜索当前 Ta 已确认留下的内容。</p>
          <form className={styles.relationshipSearch} onSubmit={submitSearch}>
            <label>
              <span className={styles.visuallyHidden}>关键词</span>
              <input
                aria-label="关系内关键词"
                disabled={!onSearch || searchState.status === "loading"}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="例如：旅行、考试、想去的地方"
                type="search"
                value={query}
              />
            </label>
            <button className={styles.secondaryButton} disabled={!onSearch || !query.trim() || searchState.status === "loading"} type="submit">
              {searchState.status === "loading" ? "正在找…" : "找一找"}
            </button>
          </form>
          {searchState.status === "error" ? <p className={styles.inlineError} role="alert">{searchState.message}</p> : null}
          {searchState.status === "ready" ? (
            searchState.results.length === 0 ? (
              <div className={styles.emptyState}><div><b>没有找到已确认内容</b><span>被排除或尚未确认的片段不会出现在结果里。</span></div></div>
            ) : (
              <ul className={styles.searchResults}>
                {searchState.results.map((result) => (
                  <li key={result.id}>
                    <time dateTime={result.recordingDate}>{formatDate(result.recordingDate)}</time>
                    <p>{result.text}</p>
                    <EvidenceList onOpenSource={onOpenSource} sources={result.sources} />
                  </li>
                ))}
              </ul>
            )
          ) : null}
        </section>

        {person.observation?.disposition === "kept" && person.observation.sources.length > 0 ? (
          <section className={styles.contentPanel}>
            <h2>关于你们的一点观察</h2>
            <p className={styles.contentIntro}>这只是根据已确认片段整理的观察，可能并不完整。</p>
            <p className={styles.observationCopy}>{person.observation.displayedText || person.observation.proposedText}</p>
            <EvidenceList onOpenSource={onOpenSource} sources={person.observation.sources} />
          </section>
        ) : null}
      </div>
    </div>
  );
}
