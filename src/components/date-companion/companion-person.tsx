"use client";

import Link from "next/link";
import { type FormEvent, useState } from "react";

import { ProductDialog, ProductEvidence, ProductState } from "@/components/product-system/product-primitives";
import type {
  DateCompanionConfirmedPerson,
  DateCompanionMutationState,
  DateCompanionSearchState,
  InteractionVM,
  PersonVM,
  PromiseVM,
  RecapItemVM,
  SourceRefVM
} from "@/lib/domain/date-companion";
import type {
  DateCompanionPersonArchiveEntry,
  DateCompanionPersonArchiveState
} from "@/lib/client/date-companion-people";

import styles from "./date-companion.module.css";

type CompanionPersonProps = {
  archiveState?: DateCompanionPersonArchiveState;
  confirmedPerson?: DateCompanionConfirmedPerson | null;
  currentInteraction: InteractionVM | null;
  isCurrentRelationship?: boolean;
  person?: PersonVM;
  searchState?: DateCompanionSearchState;
  mutationState?: DateCompanionMutationState;
  onDeleteInteraction?: (interaction: InteractionVM) => Promise<void> | void;
  onOpenInteraction?: (interaction: InteractionVM) => Promise<void> | void;
  onOpenSource?: (source: SourceRefVM, segmentId: string) => Promise<void> | void;
  onSearch?: (query: string) => Promise<void> | void;
  onUpdatePromise?: (promise: PromiseVM, status: PromiseVM["status"]) => Promise<void> | void;
};

const EMPTY_PERSON: PersonVM = {
  remembered: [],
  recent: [],
  relationship: [],
  promises: [],
  interactions: [],
  observation: null,
  limitedToCurrentInteraction: true
};

const MEMORY_TYPE_COPY: Record<DateCompanionPersonArchiveEntry["type"], string> = {
  event: "记录",
  commitment: "约定",
  question: "问题",
  relationship_signal: "相处片段",
  preference: "偏好",
  summary: "摘要"
};

const MEMORY_STATUS_COPY: Record<DateCompanionPersonArchiveEntry["status"], string> = {
  active: "当前有效",
  resolved: "已解决",
  expired: "已过期",
  superseded: "已更新"
};

const PERSON_DATE_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  day: "numeric",
  month: "numeric",
  timeZone: "Asia/Shanghai",
  year: "numeric"
});

function formatDate(value: string) {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  const date = new Date(dateOnly ? `${value}T12:00:00+08:00` : value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10);
  const parts = Object.fromEntries(PERSON_DATE_FORMATTER.formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year} 年 ${parts.month} 月 ${parts.day} 日`;
}

function sourceTime(source: SourceRefVM) {
  const seconds = Math.max(0, Math.floor(source.startSeconds));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function evidenceSources(sources: SourceRefVM[]) {
  return sources.filter((source) => (
    source.segmentIds.length > 0
    && source.quote.trim().length > 0
  ));
}

function sourcePresentationLabel(source: SourceRefVM) {
  if (source.presentation === "direct_quote") return "原话";
  if (source.presentation === "suggestion") return "支持这条建议的原话";
  return "支持这条整理的原话";
}

function visibleRecapItems(items: RecapItemVM[]) {
  return items.filter((item) => item.disposition === "kept" && evidenceSources(item.sources).length > 0);
}

function personInitials(name: string) {
  return [...name].slice(0, 2).join("");
}

function EvidenceList({
  onOpenSource,
  sources
}: {
  onOpenSource?: (source: SourceRefVM, segmentId: string) => Promise<void> | void;
  sources: SourceRefVM[];
}) {
  const evidence = evidenceSources(sources);
  if (evidence.length === 0) return null;
  return (
    <details className={styles.personEvidenceDisclosure}>
      <summary>查看来源 · {evidence.length}</summary>
      <div className={styles.personEvidenceList}>
        {evidence.map((source) => {
          const segmentId = source.segmentIds[0];
          const canOpen = Boolean(source.canOpenTranscript && segmentId && onOpenSource);
          return (
            <div key={source.id}>
              <ProductEvidence label={sourcePresentationLabel(source)} meta={`${formatDate(source.recordingDate)} · ${sourceTime(source)}`}>
                <p>{source.presentation === "direct_quote" ? `“${source.quote}”` : source.quote}</p>
              </ProductEvidence>
              {canOpen ? <button onClick={() => onOpenSource?.(source, segmentId)} type="button">在完整文字记录中查看</button> : <small>这台设备上暂时无法打开完整文字记录</small>}
            </div>
          );
        })}
      </div>
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
  const kept = visibleRecapItems(items);
  if (kept.length === 0) return <p className={styles.personSectionEmpty}>{empty}</p>;
  return (
    <ul className={styles.personFactList}>
      {kept.map((item) => (
        <li key={item.id}>
          <p>{item.displayedText || item.proposedText}</p>
          <EvidenceList onOpenSource={onOpenSource} sources={evidenceSources(item.sources)} />
        </li>
      ))}
    </ul>
  );
}

function PromiseList({
  onOpenSource,
  onUpdatePromise,
  promises
}: {
  onOpenSource?: (source: SourceRefVM, segmentId: string) => Promise<void> | void;
  onUpdatePromise?: (promise: PromiseVM, status: PromiseVM["status"]) => Promise<void> | void;
  promises: PromiseVM[];
}) {
  const [changingId, setChangingId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const visiblePromises = promises.filter((promise) => evidenceSources(promise.sources).length > 0);

  if (visiblePromises.length === 0) return <p className={styles.personSectionEmpty}>还没有带有可核对来源的明确约定。</p>;
  return (
    <div>
      {errorMessage ? <p className={styles.inlineError} role="alert">{errorMessage}</p> : null}
      <ul className={styles.personPromiseList}>
        {visiblePromises.map((promise) => (
          <li key={promise.id}>
            <div className={styles.personPromiseHeading}>
              <p>{promise.text}</p>
              <span data-status={promise.status}>{promise.status === "open" ? "仍在继续" : "已完成"}</span>
            </div>
            <EvidenceList onOpenSource={onOpenSource} sources={evidenceSources(promise.sources)} />
            {onUpdatePromise ? (
              <button
                className={styles.personTertiaryAction}
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
              >{changingId === promise.id ? "正在保存…" : promise.status === "open" ? "标为已完成" : "恢复为仍在继续"}</button>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ArchiveTimeline({ entries }: { entries: DateCompanionPersonArchiveEntry[] }) {
  const visibleEntries = entries.filter((entry) => entry.sources.length > 0);
  const hiddenCount = entries.length - visibleEntries.length;
  if (visibleEntries.length === 0) {
    return <ProductState description="没有可靠来源的内容不会作为人物信息展示。" title="还没有可核对的长期内容" tone="empty" />;
  }
  return (
    <>
      {hiddenCount > 0 ? <p className={styles.personSourceNotice}>{hiddenCount} 条内容因为来源暂不可核对，没有显示在这里。</p> : null}
      <ol className={styles.personArchiveTimeline}>
        {visibleEntries.map((entry) => (
          <li key={entry.id}>
            <div className={styles.personTimelineMarker} aria-hidden="true" />
            <article>
              <header>
                <span>{MEMORY_TYPE_COPY[entry.type]} · {MEMORY_STATUS_COPY[entry.status]}</span>
                <time dateTime={entry.date}>{formatDate(entry.date)}</time>
              </header>
              <h3>{entry.title}</h3>
              <p>{entry.summary}</p>
              <div className={styles.personArchiveMeta}>
                <span>{entry.sourceStatement}</span>
                <span>{entry.sources.length} 条来源{entry.shared ? " · 涉及多人" : ""}</span>
              </div>
              <details className={styles.personEvidenceDisclosure}>
                <summary>查看来源 · {entry.sources.length}</summary>
                <div className={styles.personEvidenceList}>
                  {entry.sources.map((source) => (
                    <div key={source.id}>
                      <ProductEvidence label="原话" meta={formatDate(source.date)}>
                        <p>“{source.quote}”</p>
                      </ProductEvidence>
                      <small>完整原话已保留；这条档案当前不提供失效的跳转链接。</small>
                    </div>
                  ))}
                </div>
              </details>
            </article>
          </li>
        ))}
      </ol>
    </>
  );
}

export function CompanionPerson({
  archiveState = { status: "idle" },
  confirmedPerson = null,
  currentInteraction,
  isCurrentRelationship = false,
  onDeleteInteraction,
  onOpenInteraction,
  onOpenSource,
  onSearch,
  onUpdatePromise,
  person = EMPTY_PERSON,
  mutationState = { status: "idle" },
  searchState = { status: "idle" }
}: CompanionPersonProps) {
  const [query, setQuery] = useState("");
  const [deleteCandidateId, setDeleteCandidateId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const archive = archiveState.status === "ready" ? archiveState.archive : null;
  const displayName = confirmedPerson?.displayName?.trim() || archive?.person.displayName?.trim() || "人物";
  const confirmedAt = confirmedPerson?.confirmedAt || archive?.person.confirmedAt || null;
  const confirmedInteractions = person.interactions.filter((interaction) => interaction.persistenceStatus === "confirmed");
  const selectedDeleteInteraction = confirmedInteractions.find((interaction) => interaction.id === deleteCandidateId) ?? null;
  const recentItems = visibleRecapItems(person.recent);
  const validSearchResults = searchState.status === "ready"
    ? searchState.results.filter((result) => evidenceSources(result.sources).length > 0)
    : [];
  const relationshipMutationError = mutationState.status === "error"
    && (mutationState.operation === "promise" || mutationState.operation === "delete")
    ? mutationState.message
    : null;

  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalized = query.trim();
    if (normalized && onSearch) void onSearch(normalized);
  };

  if (archiveState.status === "not_found") {
    return (
      <div className={styles.personBoundaryState}>
        <ProductState
          action={<Link className={styles.secondaryButton} href="/date-companion/a/people">返回人物</Link>}
          description="这位人物不存在、尚未确认，或不属于当前账号。"
          title="没有找到这位人物"
          tone="error"
        />
      </div>
    );
  }

  return (
    <div className={styles.personArchivePage}>
      <header className={styles.personArchiveHeader}>
        <Link className={styles.personBackLink} href="/date-companion/a/people">← 返回人物</Link>
        <div className={styles.personIdentity}>
          <span aria-hidden="true" className={styles.personIdentityMark}>{personInitials(displayName)}</span>
          <div>
            <p className={styles.eyebrow}>由你确认的人物</p>
            <h1>{displayName}</h1>
            <p>{confirmedAt ? `${formatDate(confirmedAt)}确认` : "只展示有可靠来源、经过确认的内容"}</p>
          </div>
        </div>
      </header>

      {archiveState.status === "loading" ? (
        <ProductState description="正在核对人物与来源。" title="正在读取人物内容" tone="loading" />
      ) : archiveState.status === "error" ? (
        <ProductState
          action={<Link className={styles.secondaryButton} href="/date-companion/a/people">返回人物</Link>}
          description={archiveState.message}
          title="人物内容暂时不可用"
          tone="error"
        />
      ) : null}

      {isCurrentRelationship ? (
        <section aria-labelledby="person-recent-title" className={styles.personPrimarySection}>
          <header className={styles.personSectionHeader}>
            <div><p className={styles.eyebrow}>最近相关内容</p><h2 id="person-recent-title">最近留下的片段</h2></div>
            <span>{recentItems.length > 0 ? `${recentItems.length} 条` : "暂无"}</span>
          </header>
          <RecapItems empty="还没有经过确认、且有原话来源的最近片段。" items={person.recent} onOpenSource={onOpenSource} />
        </section>
      ) : null}

      {isCurrentRelationship ? (
        <section aria-labelledby="person-confirmed-title" className={styles.personPrimarySection}>
          <header className={styles.personSectionHeader}>
            <div><p className={styles.eyebrow}>已确认信息</p><h2 id="person-confirmed-title">你亲自留下的内容</h2></div>
          </header>
          <div className={styles.personKnowledgeSections}>
            <details open>
              <summary><span>记得的片段</span><small>{visibleRecapItems(person.remembered).length} 条</small></summary>
              <RecapItems empty="还没有留下这一类片段。" items={person.remembered} onOpenSource={onOpenSource} />
            </details>
            <details>
              <summary><span>你们之间</span><small>{visibleRecapItems(person.relationship).length} 条</small></summary>
              <RecapItems empty="还没有经过确认、且有可核对来源的相处片段。" items={person.relationship} onOpenSource={onOpenSource} />
            </details>
            <details>
              <summary><span>明确约定</span><small>{person.promises.filter((promise) => evidenceSources(promise.sources).length > 0).length} 条</small></summary>
              <PromiseList onOpenSource={onOpenSource} onUpdatePromise={onUpdatePromise} promises={person.promises} />
            </details>
          </div>
        </section>
      ) : null}

      {archive ? (
        <section aria-labelledby="person-archive-title" className={styles.personPrimarySection}>
          <header className={styles.personSectionHeader}>
            <div><p className={styles.eyebrow}>长期相关内容</p><h2 id="person-archive-title">可追溯的内容档案</h2></div>
            <span>{archive.entries.length} 条</span>
          </header>
          <ArchiveTimeline entries={archive.entries} />
        </section>
      ) : null}

      {isCurrentRelationship && onSearch ? (
        <section aria-labelledby="relationship-search-title" className={styles.personSecondarySection}>
          <header className={styles.personSectionHeader}>
            <div><p className={styles.eyebrow}>在已确认内容中</p><h2 id="relationship-search-title">找一段过去的记录</h2></div>
          </header>
          <p className={styles.contentIntro}>只搜索当前人物已确认、且能够核对来源的内容。</p>
          <form className={styles.relationshipSearch} onSubmit={submitSearch}>
            <label>
              <span className={styles.visuallyHidden}>关键词</span>
              <input aria-label="人物内容关键词" autoComplete="off" disabled={searchState.status === "loading"} name="person-content-search" onChange={(event) => setQuery(event.currentTarget.value)} placeholder="例如：旅行、考试、想去的地方" type="search" value={query} />
            </label>
            <button className={styles.secondaryButton} disabled={!query.trim() || searchState.status === "loading"} type="submit">{searchState.status === "loading" ? "正在找…" : "找一找"}</button>
          </form>
          {searchState.status === "error" ? <p className={styles.inlineError} role="alert">{searchState.message}</p> : null}
          {searchState.status === "ready" ? (
            validSearchResults.length === 0 ? <ProductState description="被排除、尚未确认或无法核对来源的片段不会出现在结果里。" title="没有找到已确认内容" tone="empty" /> : (
              <ul className={styles.personSearchResults}>
                {validSearchResults.map((result) => (
                  <li key={result.id}>
                    <time dateTime={result.recordingDate}>{formatDate(result.recordingDate)}</time>
                    <p>{result.text}</p>
                    <EvidenceList onOpenSource={onOpenSource} sources={evidenceSources(result.sources)} />
                  </li>
                ))}
              </ul>
            )
          ) : null}
        </section>
      ) : null}

      {isCurrentRelationship ? (
        <section aria-labelledby="person-history-title" className={styles.personSecondarySection}>
          <header className={styles.personSectionHeader}>
            <div><p className={styles.eyebrow}>相处记录</p><h2 id="person-history-title">一起走过的几次</h2></div>
          </header>
          {confirmedInteractions.length === 0 ? (
            <ProductState description={currentInteraction?.status === "ready" ? "当前这次可以先在复盘页核对和确认。" : "只有最终确认过的相处会留在这里。"} title="还没有确认过的相处" tone="empty" />
          ) : (
            <ol className={styles.personInteractionList}>
              {confirmedInteractions.map((interaction) => (
                <li key={interaction.id}>
                  <time dateTime={interaction.recordingDate}>{formatDate(interaction.recordingDate)}</time>
                  <div><b>{interaction.title || interaction.fileName}</b><span>{interaction.fileName}</span></div>
                  {onOpenInteraction && interaction.relationshipInteractionId ? <button onClick={() => onOpenInteraction(interaction)} type="button">查看复盘</button> : <small>可核对原话已保留</small>}
                </li>
              ))}
            </ol>
          )}
        </section>
      ) : null}

      <section aria-labelledby="person-trust-title" className={styles.personTrustSection} id="person-trust-controls">
        <header className={styles.personSectionHeader}>
          <div><p className={styles.eyebrow}>数据与隐私</p><h2 id="person-trust-title">来源与控制</h2></div>
        </header>
        <p>人物内容与数据控制分开管理。撤销长期使用、删除一段记录和删除原始来源有不同影响，不会合并成一个含糊的“删除”。</p>
        {isCurrentRelationship ? <Link className={styles.personTrustLink} href="/date-companion/a/people#trust-controls">查看人物与长期使用设置 →</Link> : null}
        {isCurrentRelationship && confirmedInteractions.length > 0 && onDeleteInteraction ? (
          <details className={styles.personRecordControls}>
            <summary>管理相关记录</summary>
            <ul>
              {confirmedInteractions.map((interaction) => (
                <li key={interaction.id}>
                  <span><b>{interaction.title || interaction.fileName}</b><small>{formatDate(interaction.recordingDate)}</small></span>
                  <button disabled={deletingId !== null} onClick={() => { setDeleteError(null); setDeleteCandidateId(interaction.id); }} type="button">移除这次记录</button>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        {deleteError || relationshipMutationError ? <p className={styles.inlineError} role="alert">{deleteError || relationshipMutationError}</p> : null}
      </section>

      {isCurrentRelationship ? (
        <aside className={styles.personContinue}>
          <div><small>下次见面前</small><p>回看你确认留下的片段和仍在继续的约定。</p></div>
          <Link className={styles.primaryButton} href="/date-companion/a/prepare"><span>见 {displayName} 前看一眼</span><span aria-hidden="true">→</span></Link>
        </aside>
      ) : null}

      <ProductDialog
        footer={(
          <>
            <button disabled={deletingId !== null} onClick={() => setDeleteCandidateId(null)} type="button">取消</button>
            <button
              className={styles.dangerButton}
              disabled={deletingId !== null}
              onClick={async () => {
                if (!selectedDeleteInteraction || !onDeleteInteraction) return;
                setDeletingId(selectedDeleteInteraction.id);
                setDeleteError(null);
                try {
                  await onDeleteInteraction(selectedDeleteInteraction);
                  setDeleteCandidateId(null);
                } catch (error) {
                  setDeleteError(error instanceof Error && error.message.trim() ? error.message : "这次记录暂时没有移除成功。");
                } finally {
                  setDeletingId(null);
                }
              }}
              type="button"
            >{deletingId ? "正在移除…" : "确认移除记录"}</button>
          </>
        )}
        onClose={() => deletingId === null && setDeleteCandidateId(null)}
        open={Boolean(selectedDeleteInteraction)}
        title="移除这次相处记录？"
      >
        <p>将移除“{selectedDeleteInteraction?.title || selectedDeleteInteraction?.fileName || "这次相处"}”（{selectedDeleteInteraction ? formatDate(selectedDeleteInteraction.recordingDate) : "日期未知"}）。这会删除整次相处记录，并让由它产生的片段和约定重新整理；人物本身不会因此被删除。</p>
      </ProductDialog>
    </div>
  );
}
