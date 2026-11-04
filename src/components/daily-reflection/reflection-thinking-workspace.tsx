"use client";

import { useEffect, useRef, useState } from "react";

import { DailyReflectionThinkingConversationIdSchema, type ThinkingMode } from "@/lib/domain/daily-reflection-thinking";

import styles from "./daily-reflection.module.css";
import { ReflectionThinkingMatters } from "./reflection-thinking-matters";
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
  initialMode,
  initialView,
}: Readonly<{ initialMode?: ThinkingMode; initialView?: "matters" | "legacy" }>) {
  const {
    changeMode,
    conversationId,
    draft,
    initializeWorkspace,
    mode
  } = useReflectionThinking();
  const restored = useRef(false);
  const workspace = useRef<HTMLElement | null>(null);
  const [ready, setReady] = useState(false);
  const [workspaceView, setWorkspaceView] = useState<"matters" | "legacy">(() => {
    if (initialView) return initialView;
    // Quick Panel handoff remains the same conversation; it is never promoted
    // into an adopted personal goal.
    if (conversationId || draft) return "legacy";
    return "matters";
  });

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    let frame = 0;
    const update = () => {
      const element = workspace.current;
      if (!element) return;
      const visibleBottom = viewport.offsetTop + viewport.height;
      const navigation = document.querySelector<HTMLElement>("nav[aria-label='日常复盘移动导航']");
      const navigationTop = navigation && window.getComputedStyle(navigation).display !== "none"
        ? navigation.getBoundingClientRect().top : visibleBottom;
      const bottom = Math.min(visibleBottom, navigationTop);
      element.style.setProperty("--thinking-frame-height", `${Math.max(0, bottom - element.getBoundingClientRect().top)}px`);
      // Mobile keyboards can resize only the visual viewport, leaving dvh and
      // the bottom navigation below the visible screen unchanged.
      element.dataset.keyboardOpen = String(viewport.height < window.innerHeight - 120);
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(update); };
    schedule();
    viewport.addEventListener("resize", schedule);
    viewport.addEventListener("scroll", schedule);
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      viewport.removeEventListener("resize", schedule);
      viewport.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, []);

  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    const query = new URL(window.location.href).searchParams;
    const conversation = !query.has("matter") && !query.has("card")
      ? DailyReflectionThinkingConversationIdSchema.safeParse(query.get("conversation")) : null;
    const handoffRestored = initializeWorkspace(initialMode, conversation?.success ? conversation.data : undefined);
    if (!initialView) {
      if (query.has("matter") || query.has("card")) setWorkspaceView("matters");
      else if (handoffRestored) setWorkspaceView("legacy");
    }
    setReady(true);
    return () => { restored.current = false; };
  }, [initialMode, initialView, initializeWorkspace]);

  useEffect(() => {
    if (!ready || workspaceView !== "legacy" || !conversationId) return;
    const url = new URL(window.location.href);
    url.searchParams.set("conversation", conversationId);
    url.searchParams.delete("matter"); url.searchParams.delete("card");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, [conversationId, ready, workspaceView]);

  function showMatters() {
    const url = new URL(window.location.href);
    url.searchParams.delete("conversation");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    setWorkspaceView("matters");
  }

  return (
    <main className={styles.thinkingWorkspace} ref={workspace}>
      <header className={styles.thinkingWorkspaceHeader}>
        <h1>一起想</h1>
        <div className={styles.thinkingWorkspaceControls}>
          <label><span className={styles.visuallyHidden}>选择讨论记录</span>
            <select aria-label="选择讨论记录" onChange={event => {
              if (event.target.value === "matters") showMatters();
              else setWorkspaceView("legacy");
            }} value={workspaceView}>
              <option value="matters">正在想的事</option>
              <option value="legacy">继续旧对话</option>
            </select>
          </label>
          <label><span className={styles.visuallyHidden}>一起想的方式</span>
            <select aria-label="一起想的方式" onChange={event => changeMode(event.target.value as ThinkingMode)} value={mode}>
              {MODE_ORDER.map(value => <option key={value} value={value}>{THINKING_MODE_COPY[value].label}</option>)}
            </select>
          </label>
        </div>
      </header>

      {!ready ? <p role="status">正在打开一起想…</p> : workspaceView === "matters" ? <ReflectionThinkingMatters mode={mode} onModeChange={changeMode} restoreModeOnLoad={!initialMode} /> : <section aria-label="一起想工作区" className={styles.thinkingWorkspaceCanvas}>
        <ThinkingMessageViewport empty={(
          <div className={styles.thinkingEmpty}>
            <span aria-hidden="true">↗</span>
            <h2>{THINKING_MODE_COPY[mode].label}</h2>
            <p>{THINKING_MODE_COPY[mode].description}</p>
            {mode === "past_clues" ? <p>只使用有来源的个人内容；没有可靠线索时会如实说明。</p> : null}
          </div>
        )} />
        <ThinkingComposer rows={2} />
      </section>}

      <p className={styles.thinkingTrustNote}>
        {workspaceView === "matters"
          ? "讨论与进展保存在这件事里，不会自动写入长期记忆或办公待办。"
          : "这里的推演不会自动保存为卡片或长期记忆；是否留下，由你决定。"}
      </p>
    </main>
  );
}
