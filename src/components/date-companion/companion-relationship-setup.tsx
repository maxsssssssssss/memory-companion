"use client";

import { type FormEvent, useState } from "react";

import styles from "./date-companion.module.css";

type CompanionRelationshipSetupProps = {
  errorMessage?: string;
  onCreate: (displayName?: string) => Promise<void> | void;
};

export function CompanionRelationshipSetup({ errorMessage, onCreate }: CompanionRelationshipSetupProps) {
  const [displayName, setDisplayName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;

    setSubmitting(true);
    setLocalError(null);
    try {
      const normalizedName = displayName.trim();
      await onCreate(normalizedName || undefined);
    } catch (error) {
      setLocalError(error instanceof Error && error.message.trim() ? error.message : "暂时没有创建成功，请稍后再试。");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className={styles.relationshipSetupPage} aria-labelledby="relationship-setup-title">
      <section className={styles.relationshipSetupCard}>
        <span className={styles.relationshipSetupMark} aria-hidden="true">Ta</span>
        <p className={styles.eyebrow}>从一段真实关系开始</p>
        <h1 id="relationship-setup-title">你想怎样称呼 Ta？</h1>
        <p className={styles.relationshipSetupIntro}>
          名称可以以后再补。这里不会根据说话人编号、姓名、性别或对话内容猜测 Ta 是谁。
        </p>

        <form className={styles.relationshipSetupForm} onSubmit={submit}>
          <label className={styles.field}>
            <span>称呼（可选）</span>
            <input
              autoComplete="off"
              disabled={submitting}
              maxLength={80}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="不填写时就叫 Ta"
              type="text"
              value={displayName}
            />
          </label>
          {localError || errorMessage ? <p className={styles.inlineError} role="alert">{localError || errorMessage}</p> : null}
          <button className={styles.primaryButton} disabled={submitting} type="submit">
            <span>{submitting ? "正在创建…" : "开始记录这段关系"}</span>
            <span aria-hidden="true">→</span>
          </button>
        </form>

        <p className={styles.relationshipSetupBoundary}>
          第一版只保留这一段当前关系，不提供人物列表或自动切换。
        </p>
      </section>
    </main>
  );
}
