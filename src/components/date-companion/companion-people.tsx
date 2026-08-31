"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { ProductDialog, ProductState } from "@/components/product-system/product-primitives";
import type {
  DateCompanionConfirmedPerson,
  DateCompanionMemoryBridgeState,
  DateCompanionMemoryMutationState,
  DateCompanionRelationshipType
} from "@/lib/domain/date-companion";

import styles from "./date-companion.module.css";

type CompanionPeopleProps = {
  state: DateCompanionMemoryBridgeState;
  mutationState: DateCompanionMemoryMutationState;
  onCreatePerson(displayName: string): Promise<void>;
  onSaveMapping(input: {
    selfPersonId: string;
    companionPersonId: string;
    relationshipType: DateCompanionRelationshipType;
  }): Promise<void>;
  onSetRetention(enabled: boolean): Promise<void>;
  onPurge(): Promise<void>;
  onRetry(interactionId: string): Promise<void>;
  onRefresh(): Promise<void>;
};

const RELATIONSHIP_TYPES: Array<{ value: DateCompanionRelationshipType; label: string }> = [
  { value: "dating", label: "正在约会" },
  { value: "partner", label: "伴侣" },
  { value: "friend", label: "朋友" },
  { value: "other", label: "其他" }
];

const STATUS_COPY = {
  waiting_for_cleanup: "等待整理",
  pending: "等待整理",
  processing: "正在整理",
  completed: "已整理",
  retryable_failed: "整理未完成，可重试",
  needs_review: "需要重新确认人物或内容",
  cancelled: "未保留或已取消",
  not_queued: "尚未选择长期保留"
} as const;

const PERSON_DATE_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  day: "numeric",
  month: "numeric",
  timeZone: "Asia/Shanghai",
  year: "numeric"
});

function formatDate(value: string | null | undefined) {
  if (!value) return "确认时间未知";
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  const date = new Date(dateOnly ? `${value}T12:00:00+08:00` : value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10);
  const parts = Object.fromEntries(PERSON_DATE_FORMATTER.formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year} 年 ${parts.month} 月 ${parts.day} 日`;
}

function initials(person: DateCompanionConfirmedPerson) {
  const name = person.displayName?.trim() || "未命名人物";
  return [...name].slice(0, 2).join("");
}

function personLabel(
  person: DateCompanionConfirmedPerson,
  people: DateCompanionConfirmedPerson[]
) {
  const name = person.displayName?.trim() || "未命名人物";
  const sameName = people.filter((candidate) => (candidate.displayName?.trim() || "未命名人物") === name);
  if (sameName.length < 2) return name;
  return `${name} · 同名人物 ${sameName.findIndex((candidate) => candidate.id === person.id) + 1}`;
}

export function CompanionPeople({
  state,
  mutationState,
  onCreatePerson,
  onSaveMapping,
  onSetRetention,
  onPurge,
  onRetry,
  onRefresh
}: CompanionPeopleProps) {
  const [selfPersonId, setSelfPersonId] = useState("");
  const [companionPersonId, setCompanionPersonId] = useState("");
  const [relationshipType, setRelationshipType] = useState<DateCompanionRelationshipType | "">("");
  const [newPersonName, setNewPersonName] = useState("");
  const [query, setQuery] = useState("");
  const [trustOpen, setTrustOpen] = useState(false);
  const [purgeOpen, setPurgeOpen] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const newPersonInputRef = useRef<HTMLInputElement>(null);

  const mapping = state.status === "ready" ? state.mapping : null;
  useEffect(() => {
    if (state.status !== "ready") return;
    setSelfPersonId(state.mapping?.selfPersonId ?? state.selfBinding?.personId ?? "");
    setCompanionPersonId(state.mapping?.companionPersonId ?? "");
    setRelationshipType(state.mapping?.relationshipType ?? "");
  }, [state]);

  const saving = mutationState.status === "saving";
  const run = async (action: () => Promise<void>) => {
    setLocalError(null);
    try {
      await action();
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "这次操作没有完成，请稍后再试。");
    }
  };

  if (state.status === "error") {
    return (
      <div className={styles.peopleBoundaryState}>
        <ProductState
          action={<button className={styles.secondaryButton} onClick={() => void onRefresh()} type="button">重新读取</button>}
          description={state.message}
          title="人物暂时没有读取成功"
          tone="error"
        />
      </div>
    );
  }
  if (state.status !== "ready") {
    return (
      <div className={styles.peopleBoundaryState}>
        <ProductState description="正在读取由你确认的人物。" title="正在找回人物" tone="loading" />
      </div>
    );
  }

  const selfId = state.mapping?.selfPersonId ?? state.selfBinding?.personId ?? null;
  const confirmedPeople = state.people
    .filter((person) => person.id !== selfId)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
  const normalizedQuery = query.normalize("NFKC").trim().toLocaleLowerCase("zh-CN");
  const visiblePeople = normalizedQuery
    ? confirmedPeople.filter((person) => (person.displayName?.trim() || "未命名人物").toLocaleLowerCase("zh-CN").includes(normalizedQuery))
    : confirmedPeople;
  const activePersonId = mapping?.status === "confirmed" ? mapping.companionPersonId : null;
  const latestCurrentRecord = state.review.interactions
    .filter((interaction) => interaction.sourceState !== "explicitly_deleted" && interaction.status !== "cancelled")
    .sort((left, right) => right.recordingDate.localeCompare(left.recordingDate))[0];
  const mappingUsable = Boolean(
    mapping?.status === "confirmed" && mapping.selfPersonId !== mapping.companionPersonId
  );
  const mutationError = mutationState.status === "error" ? mutationState.message : null;

  const openTrustControls = (focusNewPerson = false) => {
    setTrustOpen(true);
    window.requestAnimationFrame(() => {
      const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
      document.getElementById("trust-controls")?.scrollIntoView({ block: "start", behavior: reduceMotion ? "auto" : "smooth" });
      if (focusNewPerson) newPersonInputRef.current?.focus();
    });
  };

  return (
    <div className={styles.peoplePage}>
      <header className={styles.peopleDirectoryHeader}>
        <div>
          <p className={styles.eyebrow}>约会陪伴</p>
          <h1>人物</h1>
          <p>这里是你亲自确认过的人物。姓名和原话来源不会替你判断关系。</p>
        </div>
        <button className={styles.secondaryButton} onClick={() => openTrustControls(true)} type="button">新增人物</button>
      </header>

      {(localError || mutationError) ? <p className={styles.inlineError} role="alert">{localError || mutationError}</p> : null}

      {confirmedPeople.length > 0 ? (
        <section className={styles.peopleDirectory} aria-labelledby="people-directory-title">
          <div className={styles.peopleDirectoryTools}>
            <div>
              <h2 id="people-directory-title">已确认的人物</h2>
              <span>{confirmedPeople.length} 位</span>
            </div>
            <label className={styles.peopleSearch}>
              <span className={styles.visuallyHidden}>搜索人物</span>
              <input autoComplete="off" name="people-search" onChange={(event) => setQuery(event.currentTarget.value)} placeholder="搜索人物" type="search" value={query} />
            </label>
          </div>

          {visiblePeople.length === 0 ? (
            <ProductState description="换一个称呼试试；未确认的人物不会出现在这里。" title={`没有找到“${query.trim()}”`} tone="empty" />
          ) : (
            <ul className={styles.peopleList}>
              {visiblePeople.map((person) => {
                const active = person.id === activePersonId;
                return (
                  <li key={person.id}>
                    <Link href={`/date-companion/a/people/${encodeURIComponent(person.id)}`}>
                      <span aria-hidden="true" className={styles.personAvatar}>{initials(person)}</span>
                      <span className={styles.personListContent}>
                        <span className={styles.personListHeading}>
                          <b>{personLabel(person, confirmedPeople)}</b>
                          {active ? <small>当前 Ta</small> : null}
                        </span>
                        <span>{active && latestCurrentRecord
                          ? `最近相关记录 · ${formatDate(latestCurrentRecord.recordingDate)}`
                          : `由你确认 · ${formatDate(person.confirmedAt)}`}</span>
                      </span>
                      <span aria-hidden="true" className={styles.personListArrow}>→</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ) : (
        <ProductState
          action={<button className={styles.secondaryButton} onClick={() => openTrustControls(true)} type="button">新增并确认人物</button>}
          description="人物只会在你明确确认后出现；系统不会根据名字或对话自动创建。"
          title="还没有已确认的人物"
          tone="empty"
        />
      )}

      <details className={styles.peopleTrustDisclosure} id="trust-controls" onToggle={(event) => setTrustOpen(event.currentTarget.open)} open={trustOpen}>
        <summary>
          <span><b>数据与隐私</b><small>人物确认、长期保留与删除控制</small></span>
          <span aria-hidden="true">＋</span>
        </summary>
        <div className={styles.peopleTrustBody}>
          <section aria-labelledby="people-mapping-title" className={styles.peopleTrustSection}>
            <div className={styles.peoplePanelHeading}>
              <div>
                <p className={styles.eyebrow}>人物确认</p>
                <h2 id="people-mapping-title">确认当前这段关系</h2>
                <p>这项设置只作用于当前 Date Companion 关系，不会按名字自动匹配其他人物。</p>
              </div>
              <span className={styles.mappingStatus} data-active={mappingUsable}>{mappingUsable ? "已确认" : "需要确认"}</span>
            </div>

            <div className={styles.peopleMappingGrid}>
              <label>
                <span>我</span>
                <select disabled={saving} onChange={(event) => setSelfPersonId(event.currentTarget.value)} value={selfPersonId}>
                  <option value="">请选择</option>
                  {state.people.map((person) => <option key={person.id} value={person.id}>{personLabel(person, state.people)}</option>)}
                </select>
              </label>
              <label>
                <span>Ta</span>
                <select disabled={saving} onChange={(event) => setCompanionPersonId(event.currentTarget.value)} value={companionPersonId}>
                  <option value="">请选择</option>
                  {state.people.map((person) => <option key={person.id} value={person.id}>{personLabel(person, state.people)}</option>)}
                </select>
              </label>
              <label>
                <span>由你选择的关系</span>
                <select disabled={saving} onChange={(event) => setRelationshipType(event.currentTarget.value as DateCompanionRelationshipType | "")} value={relationshipType}>
                  <option value="">请选择</option>
                  {RELATIONSHIP_TYPES.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
                </select>
              </label>
            </div>

            {selfPersonId && selfPersonId === companionPersonId ? <p className={styles.boundaryNote}>“我”和“Ta”不能是同一个人物，请重新选择。</p> : null}

            <div className={styles.peoplePanelActions}>
              <button
                className={styles.primaryButton}
                disabled={saving || !selfPersonId || !companionPersonId || !relationshipType || selfPersonId === companionPersonId}
                onClick={() => relationshipType && void run(() => onSaveMapping({ selfPersonId, companionPersonId, relationshipType }))}
                type="button"
              ><span>{mutationState.status === "saving" && mutationState.operation === "mapping" ? "正在保存…" : "确认当前人物"}</span><span aria-hidden="true">✓</span></button>
              <small>修改这里不会自动创建新的长期记忆。</small>
            </div>

            <div className={styles.createPersonRow}>
              <label htmlFor="new-person-name">新增人物</label>
              <input autoComplete="off" id="new-person-name" maxLength={500} name="new-person-display-name" onChange={(event) => setNewPersonName(event.currentTarget.value)} placeholder="输入你能认出的称呼" ref={newPersonInputRef} value={newPersonName} />
              <button
                disabled={saving || !newPersonName.trim()}
                onClick={() => void run(async () => {
                  await onCreatePerson(newPersonName);
                  setNewPersonName("");
                })}
                type="button"
              >新增并确认</button>
            </div>
          </section>

          <section aria-labelledby="retention-title" className={styles.peopleTrustSection}>
            <div className={styles.retentionRow}>
              <div>
                <p className={styles.eyebrow}>长期使用</p>
                <h2 id="retention-title">允许未来使用已确认内容</h2>
                <p>只有你明确保留、确认人物和内容归属后，才会进入长期关系记忆。</p>
              </div>
              <button aria-checked={state.setting.enabled} className={styles.retentionSwitch} data-enabled={state.setting.enabled} disabled={saving || (!mappingUsable && !state.setting.enabled)} onClick={() => void run(() => onSetRetention(!state.setting.enabled))} role="switch" type="button">
                <span aria-hidden="true" /><b>{state.setting.enabled ? "已开启" : "已关闭"}</b>
              </button>
            </div>
            <p className={styles.boundaryNote}>关闭只会停止未来新增，不会删除以前已经保留的内容。</p>
          </section>

          <section aria-labelledby="sync-title" className={styles.peopleTrustSection}>
            <div className={styles.peoplePanelHeading}>
              <div><p className={styles.eyebrow}>处理状态</p><h2 id="sync-title">已确认内容的整理情况</h2></div>
              <button className={styles.textButton} disabled={saving} onClick={() => void onRefresh()} type="button">刷新</button>
            </div>
            {state.review.interactions.length === 0 ? <p className={styles.contentIntro}>还没有需要整理的已确认记录。</p> : (
              <ul className={styles.syncList}>
                {state.review.interactions.map((interaction) => {
                  const retryable = interaction.status === "retryable_failed";
                  return (
                    <li key={interaction.interactionId}>
                      <div><b>{formatDate(interaction.recordingDate)}</b><span>{STATUS_COPY[interaction.status]}</span></div>
                      {retryable ? (
                        <button disabled={saving} onClick={() => void run(() => onRetry(interaction.interactionId))} type="button">
                          {mutationState.status === "saving" && mutationState.targetId === interaction.interactionId ? "正在重试…" : "重新整理"}
                        </button>
                      ) : interaction.status === "needs_review" ? <Link href={`/date-companion/a/recap?interaction=${encodeURIComponent(interaction.interactionId)}`}>去重新确认</Link> : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section aria-labelledby="purge-title" className={`${styles.peopleTrustSection} ${styles.peopleDangerZone}`}>
            <p className={styles.eyebrow}>删除长期内容</p>
            <h2 id="purge-title">删除当前关系已保留的内容</h2>
            <p>这会删除当前人物映射下、由这段关系进入长期使用的内容。人物本身和原始单次复盘不会因此被删除。</p>
            <button className={styles.dangerButton} disabled={saving || !mappingUsable} onClick={() => setPurgeOpen(true)} type="button">查看删除影响</button>
          </section>
        </div>
      </details>

      <ProductDialog
        footer={(
          <>
            <button disabled={saving} onClick={() => setPurgeOpen(false)} type="button">取消</button>
            <button className={styles.dangerButton} disabled={saving} onClick={() => void run(async () => { await onPurge(); setPurgeOpen(false); })} type="button">
              {mutationState.status === "saving" && mutationState.operation === "purge" ? "正在删除…" : "确认删除长期内容"}
            </button>
          </>
        )}
        onClose={() => { if (!saving) setPurgeOpen(false); }}
        open={purgeOpen}
        title="删除当前关系的长期内容？"
      >
        <p>删除后，这些内容不再出现在人物页和见面前准备中。人物设置与原始复盘仍会保留。</p>
      </ProductDialog>
    </div>
  );
}
