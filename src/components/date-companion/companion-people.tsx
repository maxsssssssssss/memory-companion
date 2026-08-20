"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import type {
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

function personOptionLabel(
  id: string,
  displayName: string | null,
  duplicateNames: ReadonlySet<string>
) {
  const name = displayName?.trim() || "未命名人物";
  return duplicateNames.has(name) ? `${name} · 人物号 ${id.slice(-6)}` : name;
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
  const [relationshipType, setRelationshipType] = useState<DateCompanionRelationshipType>("dating");
  const [newPersonName, setNewPersonName] = useState("");
  const [purgeArmed, setPurgeArmed] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const mapping = state.status === "ready" ? state.mapping : null;
  useEffect(() => {
    if (state.status !== "ready") return;
    setSelfPersonId(state.mapping?.selfPersonId ?? state.selfBinding?.personId ?? "");
    setCompanionPersonId(state.mapping?.companionPersonId ?? "");
    setRelationshipType(state.mapping?.relationshipType ?? "dating");
  }, [state]);

  const duplicateNames = useMemo(() => {
    if (state.status !== "ready") return new Set<string>();
    const counts = new Map<string, number>();
    for (const person of state.people) {
      const name = person.displayName?.trim() || "未命名人物";
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return new Set([...counts].filter(([, count]) => count > 1).map(([name]) => name));
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
      <section className={styles.peopleLoading}>
        <h1>人物设置暂时没有读取成功</h1>
        <p role="alert">{state.message}</p>
        <button className={styles.primaryButton} onClick={() => void onRefresh()} type="button">
          <span>重新读取</span><span aria-hidden="true">↻</span>
        </button>
      </section>
    );
  }
  if (state.status !== "ready") {
    return <section className={styles.peopleLoading} role="status">正在找回人物与长期保留设置…</section>;
  }

  const mappingUsable = Boolean(
    mapping?.status === "confirmed" &&
    mapping.selfPersonId !== mapping.companionPersonId
  );
  const mutationError = mutationState.status === "error" ? mutationState.message : null;

  return (
    <div className={styles.peoplePage}>
      <header className={styles.peopleHero}>
        <p className={styles.eyebrow}>人物与长期保留</p>
        <h1>由你确认，谁是我，谁是 Ta</h1>
        <p>姓名、声音编号和聊天内容都不会替你决定人物。只有你明确选择后，未来符合条件的相处才会整理进长期记录。</p>
      </header>

      {(localError || mutationError) ? <p className={styles.inlineError} role="alert">{localError || mutationError}</p> : null}

      <section className={styles.peoplePanel} aria-labelledby="people-mapping-title">
        <div className={styles.peoplePanelHeading}>
          <div>
            <p className={styles.eyebrow}>01 · 人物</p>
            <h2 id="people-mapping-title">确认这段关系里的两个人</h2>
          </div>
          <span className={styles.mappingStatus} data-active={mappingUsable}>
            {mappingUsable ? "已生效" : "需要确认"}
          </span>
        </div>

        <div className={styles.peopleMappingGrid}>
          <label>
            <span>我</span>
            <select disabled={saving} onChange={(event) => setSelfPersonId(event.currentTarget.value)} value={selfPersonId}>
              <option value="">请选择</option>
              {state.people.map((person) => (
                <option key={person.id} value={person.id}>{personOptionLabel(person.id, person.displayName, duplicateNames)}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Ta</span>
            <select disabled={saving} onChange={(event) => setCompanionPersonId(event.currentTarget.value)} value={companionPersonId}>
              <option value="">请选择</option>
              {state.people.map((person) => (
                <option key={person.id} value={person.id}>{personOptionLabel(person.id, person.displayName, duplicateNames)}</option>
              ))}
            </select>
          </label>
          <label>
            <span>你们现在的关系</span>
            <select disabled={saving} onChange={(event) => setRelationshipType(event.currentTarget.value as DateCompanionRelationshipType)} value={relationshipType}>
              {RELATIONSHIP_TYPES.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
            </select>
          </label>
        </div>

        {selfPersonId && selfPersonId === companionPersonId ? (
          <p className={styles.boundaryNote}>“我”和“Ta”不能是同一个人物，请重新选择。</p>
        ) : null}

        <div className={styles.peoplePanelActions}>
          <button
            className={styles.primaryButton}
            disabled={saving || !selfPersonId || !companionPersonId || selfPersonId === companionPersonId}
            onClick={() => void run(() => onSaveMapping({ selfPersonId, companionPersonId, relationshipType }))}
            type="button"
          ><span>{mutationState.status === "saving" && mutationState.operation === "mapping" ? "正在保存…" : "确认人物设置"}</span><span aria-hidden="true">✓</span></button>
          {mapping ? <small>这是你第 {mapping.version} 次确认人物设置。</small> : <small>第一次确认后，仍可在这里重新选择。</small>}
        </div>

        <div className={styles.createPersonRow}>
          <label htmlFor="new-person-name">没有合适的人物？</label>
          <input
            id="new-person-name"
            maxLength={500}
            onChange={(event) => setNewPersonName(event.currentTarget.value)}
            placeholder="输入你能认出的称呼"
            value={newPersonName}
          />
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

      <section className={styles.peoplePanel} aria-labelledby="retention-title">
        <div className={styles.retentionRow}>
          <div>
            <p className={styles.eyebrow}>02 · 长期保留</p>
            <h2 id="retention-title">长期保留关系记忆</h2>
            <p>默认开启。只有你确认保留、确认人物和内容归属后，才会进入长期关系记忆。</p>
          </div>
          <button
            aria-checked={state.setting.enabled}
            className={styles.retentionSwitch}
            data-enabled={state.setting.enabled}
            disabled={saving || (!mappingUsable && !state.setting.enabled)}
            onClick={() => void run(() => onSetRetention(!state.setting.enabled))}
            role="switch"
            type="button"
          ><span aria-hidden="true" /><b>{state.setting.enabled ? "已开启" : "已关闭"}</b></button>
        </div>
        <p className={styles.boundaryNote}>关闭只会停止未来新增，不会删除以前已经保留的内容。</p>
      </section>

      <section className={styles.peoplePanel} aria-labelledby="sync-title">
        <div className={styles.peoplePanelHeading}>
          <div>
            <p className={styles.eyebrow}>03 · 整理状态</p>
            <h2 id="sync-title">最近相处的整理情况</h2>
          </div>
          <button className={styles.textButton} disabled={saving} onClick={() => void onRefresh()} type="button">刷新</button>
        </div>
        {state.review.interactions.length === 0 ? (
          <p className={styles.contentIntro}>还没有已经确认的相处记录。</p>
        ) : (
          <ul className={styles.syncList}>
            {state.review.interactions.map((interaction) => {
              const retryable = interaction.status === "retryable_failed";
              return (
                <li key={interaction.interactionId}>
                  <div><b>{interaction.recordingDate}</b><span>{STATUS_COPY[interaction.status]}</span></div>
                  {retryable ? (
                    <button
                      disabled={saving}
                      onClick={() => void run(() => onRetry(interaction.interactionId))}
                      type="button"
                    >{mutationState.status === "saving" && mutationState.targetId === interaction.interactionId ? "正在重试…" : "重新整理"}</button>
                  ) : interaction.status === "needs_review" ? (
                    <Link href={`/date-companion/a/recap?interaction=${encodeURIComponent(interaction.interactionId)}`}>去重新确认</Link>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className={`${styles.peoplePanel} ${styles.dangerPanel}`} aria-labelledby="purge-title">
        <p className={styles.eyebrow}>单独删除</p>
        <h2 id="purge-title">删除这段关系已保留的内容</h2>
        <p>这会删除当前“我”和“Ta”映射下、由这段关系保留下来的长期内容。人物设置和原始单次复盘不会因此被伪装成已删除。</p>
        {!purgeArmed ? (
          <button className={styles.dangerButton} disabled={saving} onClick={() => setPurgeArmed(true)} type="button">准备删除</button>
        ) : (
          <div className={styles.purgeConfirm} role="group" aria-label="确认删除已保留内容">
            <p>请再确认一次：删除成功后，相关长期内容将不再出现在人物页和见面前准备中。</p>
            <button disabled={saving} onClick={() => setPurgeArmed(false)} type="button">取消</button>
            <button
              className={styles.dangerButton}
              disabled={saving}
              onClick={() => void run(async () => {
                await onPurge();
                setPurgeArmed(false);
              })}
              type="button"
            >{mutationState.status === "saving" && mutationState.operation === "purge" ? "正在删除…" : "确认删除已保留内容"}</button>
          </div>
        )}
      </section>
    </div>
  );
}
