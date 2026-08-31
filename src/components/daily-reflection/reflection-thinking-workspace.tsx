"use client";

import { useEffect, useRef } from "react";

import type { ThinkingMode } from "@/lib/domain/daily-reflection-thinking";

import styles from "./daily-reflection.module.css";
import {
  THINKING_MODE_COPY,
  ThinkingComposer,
  ThinkingMessageViewport,
  useReflectionThinking
} from "./reflection-thinking-panel";

const MODE_ORDER: ThinkingMode[] = [
  "brainstorm",
  "clarify_decision",
  "compare_directions",
  "extend_idea",
  "past_clues"
];

export function ReflectionThinkingWorkspace({
  initialMode
}: Readonly<{ initialMode?: ThinkingMode }>) {
  const {
    changeMode,
    initializeWorkspace,
    mode
  } = useReflectionThinking();
  const restored = useRef(false);

  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    initializeWorkspace(initialMode);
  }, [initialMode, initializeWorkspace]);

  return (
    <main className={styles.thinkingWorkspace}>
      <header className={styles.thinkingWorkspaceHeader}>
        <p className={styles.eyebrow}>Daily Reflection</p>
        <h1>一起想</h1>
        <p>把一个还没成形的念头放在这里，慢慢看清它的方向。</p>
      </header>

      <section aria-label="一起想的方式" className={styles.thinkingModeSection}>
        <div aria-label="一起想的方式" className={styles.thinkingModeTabs} role="group">
          {MODE_ORDER.map((value) => (
            <button
              aria-pressed={mode === value}
              key={value}
              onClick={() => changeMode(value)}
              type="button"
            >
              {THINKING_MODE_COPY[value].label}
            </button>
          ))}
        </div>
        <p className={styles.thinkingModeDescription}>{THINKING_MODE_COPY[mode].description}</p>
      </section>

      {mode === "past_clues" ? (
        <p className={styles.thinkingPastCluesScope}>只使用有来源的个人内容；没有可靠线索时会如实说明。</p>
      ) : null}

      <section aria-label="一起想工作区" className={styles.thinkingWorkspaceCanvas}>
        <ThinkingMessageViewport empty={(
          <div className={styles.thinkingEmpty}>
            <span aria-hidden="true">↗</span>
            <h2>{THINKING_MODE_COPY[mode].label}</h2>
            <p>{THINKING_MODE_COPY[mode].description}</p>
          </div>
        )} />
        <ThinkingComposer />
      </section>

      <p className={styles.thinkingTrustNote}>
        这里的推演不会自动保存为卡片或长期记忆；是否留下，由你决定。
      </p>
    </main>
  );
}
