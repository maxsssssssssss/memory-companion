"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { ProductState } from "@/components/product-system/product-primitives";
import type {
  DateCompanionConfirmedPerson,
  DateCompanionMemoryBridgeState,
  DateCompanionMemoryMutationState,
  DateCompanionRelationshipType
} from "@/lib/domain/date-companion";

import { CompanionWithdrawal } from "./companion-withdrawal";
import type { WithdrawalImpact, WithdrawalReceipt } from "@/lib/client/date-companion-api";
import styles from "./date-companion.module.css";

type CompanionPeopleProps = {
  titleForRecord?: (interactionId: string) => string | null;
  hrefFor?: (path: string) => string;
  state: DateCompanionMemoryBridgeState;
  mutationState: DateCompanionMemoryMutationState;
  onCreatePerson(displayName: string): Promise<void>;
  onSaveMapping(input: {
    selfPersonId: string;
    companionPersonId: string;
    relationshipType: DateCompanionRelationshipType;
  }): Promise<void>;
  onSetRetention(enabled: boolean): Promise<void>;
  onPreviewWithdrawal(signal: AbortSignal): Promise<WithdrawalImpact>;
  onPurge(version: string): Promise<WithdrawalReceipt>;
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
  titleForRecord,
  hrefFor = (path: string) => path,
  state,
  mutationState,
  onCreatePerson,
  onSaveMapping,
  onSetRetention,
  onPreviewWithdrawal,
  onPurge,
  onRetry,
  onRefresh
}: CompanionPeopleProps) {
  const [selfPersonId, setSelfPersonId] = useState("");
  const [companionPersonId, setCompanionPersonId] = useState("");
  const [relationshipType, setRelationshipType] = useState<DateCompanionRelationshipType | "">("");
  const [newPersonName, setNewPersonName] = useState("");
  const [trustOpen, setTrustOpen] = useState(true);
  const [mappingEntry, setMappingEntry] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const mappingEdited = useRef(false);

  const mapping = state.status === "ready" ? state.mapping : null;
  useEffect(() => {
    if (state.status !== "ready" || mappingEdited.current) return;
    setSelfPersonId(state.mapping?.selfPersonId ?? state.selfBinding?.personId ?? "");
    setCompanionPersonId(state.mapping?.companionPersonId ?? "");
    setRelationshipType(state.mapping?.relationshipType ?? "");
  }, [state]);

  useEffect(() => {
    if (state.status !== "ready") return;
    let frame = 0;
    const revealMapping = () => {
      const anchor = window.location.hash.slice(1);
      if (anchor === "retention-title" || anchor === "new-person-name") {
        setTrustOpen(true);
        window.cancelAnimationFrame(frame);
        frame = window.requestAnimationFrame(() => {
          const target = document.getElementById(anchor);
          target?.focus({preventScroll: true});
          target?.scrollIntoView({block: "nearest", behavior: "instant"});
        });
        return;
      }
      if (window.location.hash !== "#people-mapping-title") return;
      setTrustOpen(true);
      setMappingEntry(true);
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const heading = document.getElementById("people-mapping-title");
        if (!heading) return;
        const section = heading.closest("section");
        const chrome = heading.closest("main")?.querySelector<HTMLElement>(`.${styles.companionChrome}`);
        const chromePosition = chrome ? window.getComputedStyle(chrome).position : "";
        const chromeHeight = chrome && ["sticky", "fixed"].includes(chromePosition) ? chrome.getBoundingClientRect().height : 0;
        const sectionInset = section ? heading.getBoundingClientRect().top - section.getBoundingClientRect().top : 0;
        // The hash and our explicit reveal share one offset, including the return
        // link above the title. Neither path may tuck the form under the shell.
        heading.style.scrollMarginTop = `${Math.ceil(chromeHeight + sectionInset + 16)}px`;
        heading?.focus({preventScroll:true});
        heading?.scrollIntoView({block:"start",behavior:"instant"});
      });
    };
    revealMapping();
    window.addEventListener("hashchange", revealMapping);
    return () => { window.cancelAnimationFrame(frame); window.removeEventListener("hashchange",revealMapping); };
  }, [state.status]);

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

  const mappingUsable = Boolean(
    mapping?.status === "confirmed" && mapping.selfPersonId !== mapping.companionPersonId
  );
  const mutationError = mutationState.status === "error" ? mutationState.message : null;

  return (
    <div className={styles.peoplePage}>
      {(localError || mutationError) ? <p className={styles.inlineError} role="alert">{localError || mutationError}</p> : null}

      <details className={styles.peopleTrustDisclosure} id="trust-controls" onToggle={(event) => setTrustOpen(event.currentTarget.open)} open={trustOpen}>
        <summary>
          <span><b>数据与隐私</b><small>人物确认、长期保留与删除控制</small></span>
          <span aria-hidden="true">＋</span>
        </summary>
        <div className={styles.peopleTrustBody}>
          <section aria-labelledby="people-mapping-title" className={styles.peopleTrustSection}>
            {mappingEntry && <Link className={styles.textButton} href={hrefFor("/date-companion/a")}>返回首页</Link>}
            <div className={styles.peoplePanelHeading}>
              <div>
                <p className={styles.eyebrow}>人物确认</p>
                <h2 id="people-mapping-title" tabIndex={-1}>确认当前这段关系</h2>
                <p>这项设置只作用于当前 Date Companion 关系，不会按名字自动匹配其他人物。</p>
              </div>
              <span className={styles.mappingStatus} data-active={mappingUsable}>{mappingUsable ? "已确认" : "需要确认"}</span>
            </div>

            <div className={styles.peopleMappingGrid} onChange={() => { mappingEdited.current = true; }}>
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
                onClick={() => relationshipType && void run(async () => {
                  await onSaveMapping({ selfPersonId, companionPersonId, relationshipType });
                  mappingEdited.current = false;
                })}
                type="button"
              ><span>{mutationState.status === "saving" && mutationState.operation === "mapping" ? "正在保存…" : "确认当前人物"}</span><span aria-hidden="true">✓</span></button>
              <small>修改这里不会自动创建新的长期记忆。</small>
            </div>

            <div className={styles.createPersonRow}>
              <label htmlFor="new-person-name">新增人物</label>
              <input autoComplete="off" id="new-person-name" maxLength={500} name="new-person-display-name" onChange={(event) => setNewPersonName(event.currentTarget.value)} placeholder="输入你能认出的称呼" value={newPersonName} />
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
                <h2 id="retention-title" tabIndex={-1}>允许未来使用已确认内容</h2>
                <p>只有你明确保留、确认人物和内容归属后，才会进入长期关系记忆。</p>
              </div>
              <button aria-checked={state.setting.enabled} className={styles.retentionSwitch} data-enabled={state.setting.enabled} disabled={saving} onClick={() => void run(() => onSetRetention(!state.setting.enabled))} role="switch" type="button">
                <span aria-hidden="true" /><b>{state.setting.enabled ? "已开启" : "已关闭"}</b>
              </button>
            </div>
            <p className={styles.boundaryNote}>这个开关适用于整个账号。关闭后，已提交的整理继续，已纳入的资料保留。再次开启时，由你选择新的内容。</p>
          </section>

          <section aria-labelledby="sync-title" className={styles.peopleTrustSection}>
            <div className={styles.peoplePanelHeading}>
              <div><p className={styles.eyebrow}>处理状态</p><h2 id="sync-title">已确认内容的整理情况</h2></div>
              <button className={styles.textButton} disabled={saving} onClick={() => void onRefresh()} type="button">刷新</button>
            </div>
            {state.review.interactions.length === 0 ? <p className={styles.contentIntro}>还没有需要整理的已确认记录。</p> : (
              <ul className={styles.syncList}>
                {state.review.interactions.map((interaction) => {
                  const title = titleForRecord?.(interaction.interactionId);
                  const date = formatDate(interaction.recordingDate);
                  const recordLabel = title ? `${title} · ${date}` : date;
                  const retryable = interaction.status === "retryable_failed";
                  return (
                    <li key={interaction.interactionId}>
                      <div><b>{title || date}</b><span>{title && <><time dateTime={interaction.recordingDate}>{date}</time> · </>}{STATUS_COPY[interaction.status]}</span></div>
                      {retryable ? (
                        <button aria-label={`重新整理 · ${recordLabel}`} disabled={saving} onClick={() => void run(() => onRetry(interaction.interactionId))} type="button">
                          {mutationState.status === "saving" && mutationState.targetId === interaction.interactionId ? "正在重试…" : "重新整理"}
                        </button>
                      ) : interaction.status === "needs_review" ? <Link aria-label={`去重新确认 · ${recordLabel}`} href={hrefFor(`/date-companion/a/recap?interaction=${encodeURIComponent(interaction.interactionId)}`)}>去重新确认</Link> : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <CompanionWithdrawal busy={saving} read={onPreviewWithdrawal} submit={onPurge} />
        </div>
      </details>
    </div>
  );
}
