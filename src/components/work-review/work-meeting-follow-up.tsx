"use client";

import {
  type ChangeEvent,
  type MutableRefObject,
  useEffect,
  useRef,
  useState
} from "react";

import { ProductDialog, ProductState } from "@/components/product-system/product-primitives";
import {
  isDefinitiveWorkReviewApiError,
  WorkReviewApiError,
  type WorkMeetingFollowUpDraft,
  type WorkMeetingFollowUpGetResponse,
  type WorkReviewApi
} from "@/lib/client/work-review-api";

import styles from "./work-review.module.css";

type FollowUpLoadState = "idle" | "loading" | "ready" | "error";
type FollowUpBusyAction = "generate" | "save" | "reset" | null;
type FollowUpConfirmAction = "regenerate" | "reset" | null;

export type WorkMeetingFollowUpState = Readonly<{
  bodyMarkdown: string;
  busyAction: FollowUpBusyAction;
  draft: WorkMeetingFollowUpDraft | null;
  dirty: boolean;
  editing: boolean;
  error: string | null;
  loadState: FollowUpLoadState;
  notice: string | null;
  sourceStats: WorkMeetingFollowUpGetResponse["sourceStats"] | null;
  versionConflict: boolean;
  cancelEditing: () => void;
  changeBody: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  copy: (value: string, successMessage: string) => Promise<void>;
  generate: () => Promise<void>;
  reload: () => void;
  reloadLatest: () => void;
  reset: () => Promise<void>;
  save: () => Promise<void>;
  startEditing: () => void;
}>;

function operationKey(prefix: string) {
  const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${id}`;
}

function actionError(error: unknown) {
  if (error instanceof WorkReviewApiError && error.code === "version_conflict") {
    return "这份纪要已在其他页面更新。你的文字仍保留在编辑框中；重新载入后再继续保存。";
  }
  return error instanceof WorkReviewApiError
    ? error.message
    : "暂时无法完成这项操作，请稍后重试。";
}

function keyForOperation(
  keys: MutableRefObject<Map<string, string>>,
  logicalKey: string,
  prefix: string
) {
  const existing = keys.current.get(logicalKey);
  if (existing) return existing;
  const created = operationKey(prefix);
  keys.current.set(logicalKey, created);
  return created;
}

function settleOperation(
  keys: MutableRefObject<Map<string, string>>,
  logicalKey: string,
  error?: unknown
) {
  if (error === undefined || isDefinitiveWorkReviewApiError(error)) {
    keys.current.delete(logicalKey);
  }
}

export function useWorkMeetingFollowUp({
  active,
  api,
  enabled,
  meetingId,
  sourceRevision = ""
}: Readonly<{
  active: boolean;
  api?: WorkReviewApi;
  enabled: boolean;
  meetingId: string;
  sourceRevision?: string;
}>): WorkMeetingFollowUpState {
  const [loadState, setLoadState] = useState<FollowUpLoadState>("idle");
  const [draft, setDraft] = useState<WorkMeetingFollowUpDraft | null>(null);
  const [bodyMarkdown, setBodyMarkdown] = useState("");
  const [editing, setEditing] = useState(false);
  const [busyAction, setBusyAction] = useState<FollowUpBusyAction>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [versionConflict, setVersionConflict] = useState(false);
  const [sourceStats, setSourceStats] = useState<WorkMeetingFollowUpGetResponse["sourceStats"] | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const operationKeysRef = useRef(new Map<string, string>());
  const draftRef = useRef(draft);
  const bodyMarkdownRef = useRef(bodyMarkdown);
  const editingRef = useRef(editing);
  const preserveBodyOnNextLoadRef = useRef(false);
  draftRef.current = draft;
  bodyMarkdownRef.current = bodyMarkdown;
  editingRef.current = editing;

  useEffect(() => {
    draftRef.current = null;
    bodyMarkdownRef.current = "";
    editingRef.current = false;
    setLoadState("idle");
    setDraft(null);
    setBodyMarkdown("");
    setEditing(false);
    setBusyAction(null);
    setError(null);
    setNotice(null);
    setVersionConflict(false);
    setSourceStats(null);
    preserveBodyOnNextLoadRef.current = false;
    operationKeysRef.current.clear();
  }, [meetingId]);

  useEffect(() => {
    if (!active || !api || !enabled) return;
    const controller = new AbortController();
    setLoadState("loading");
    setError(null);
    void api.getMeetingFollowUp(meetingId, controller.signal).then((response) => {
      if (controller.signal.aborted) return;
      const preserveUnsavedBody = preserveBodyOnNextLoadRef.current || editingRef.current
        && bodyMarkdownRef.current !== draftRef.current?.bodyMarkdown;
      setDraft(response.draft);
      if (!preserveUnsavedBody) setBodyMarkdown(response.draft?.bodyMarkdown ?? "");
      if (preserveBodyOnNextLoadRef.current) {
        setEditing(true);
        setNotice("已载入最新服务器版本；你的文字仍保留在编辑框中，请核对后再次保存。");
      }
      preserveBodyOnNextLoadRef.current = false;
      setVersionConflict(false);
      setSourceStats(response.sourceStats);
      setLoadState("ready");
    }).catch((nextError: unknown) => {
      if (controller.signal.aborted || nextError instanceof DOMException && nextError.name === "AbortError") return;
      setError(actionError(nextError));
      setLoadState("error");
    });
    return () => controller.abort();
  }, [active, api, enabled, loadAttempt, meetingId, sourceRevision]);

  const applyDraft = (next: WorkMeetingFollowUpDraft, successMessage: string) => {
    setDraft(next);
    setBodyMarkdown(next.bodyMarkdown);
    setEditing(false);
    setError(null);
    setNotice(successMessage);
    setVersionConflict(false);
    setSourceStats(next.sourceStats);
    setLoadState("ready");
  };

  const generate = async () => {
    if (!api || busyAction) return;
    const logicalKey = `follow-up:generate:${meetingId}:${draft?.version ?? "new"}:${draft?.currentSnapshotDigest ?? "none"}`;
    setBusyAction("generate");
    setError(null);
    setNotice(null);
    setVersionConflict(false);
    try {
      const next = await api.generateMeetingFollowUp(
        meetingId,
        {
          expectedVersion: draft?.version ?? null,
          operationKey: keyForOperation(operationKeysRef, logicalKey, "follow-up-generate")
        }
      );
      settleOperation(operationKeysRef, logicalKey);
      applyDraft(next, draft ? "已按最新会议结果与待办重新生成纪要。" : "会后纪要草稿已生成。");
    } catch (nextError) {
      settleOperation(operationKeysRef, logicalKey, nextError);
      setVersionConflict(nextError instanceof WorkReviewApiError && nextError.code === "version_conflict");
      setError(actionError(nextError));
    } finally {
      setBusyAction(null);
    }
  };

  const save = async () => {
    if (!api || !draft || busyAction) return;
    const trimmedBody = bodyMarkdown.trim();
    if (!trimmedBody) {
      setError("纪要正文不能为空。请补充内容后再保存。");
      return;
    }
    const logicalKey = `follow-up:save:${meetingId}:${draft.version}:${trimmedBody}`;
    setBusyAction("save");
    setError(null);
    setNotice(null);
    setVersionConflict(false);
    try {
      const next = await api.updateMeetingFollowUp(meetingId, {
        bodyMarkdown: trimmedBody,
        expectedVersion: draft.version,
        operationKey: keyForOperation(operationKeysRef, logicalKey, "follow-up-save")
      });
      settleOperation(operationKeysRef, logicalKey);
      applyDraft(next, "纪要修改已保存。");
    } catch (nextError) {
      settleOperation(operationKeysRef, logicalKey, nextError);
      setVersionConflict(nextError instanceof WorkReviewApiError && nextError.code === "version_conflict");
      setError(actionError(nextError));
    } finally {
      setBusyAction(null);
    }
  };

  const reset = async () => {
    if (!api || !draft || busyAction) return;
    const logicalKey = `follow-up:reset:${meetingId}:${draft.version}:${draft.systemSnapshotDigest}`;
    setBusyAction("reset");
    setError(null);
    setNotice(null);
    setVersionConflict(false);
    try {
      const next = await api.resetMeetingFollowUp(
        meetingId,
        {
          expectedVersion: draft.version,
          operationKey: keyForOperation(operationKeysRef, logicalKey, "follow-up-reset")
        }
      );
      settleOperation(operationKeysRef, logicalKey);
      applyDraft(next, "已恢复为最近一次系统生成的版本。");
    } catch (nextError) {
      settleOperation(operationKeysRef, logicalKey, nextError);
      setVersionConflict(nextError instanceof WorkReviewApiError && nextError.code === "version_conflict");
      setError(actionError(nextError));
    } finally {
      setBusyAction(null);
    }
  };

  const copy = async (value: string, successMessage: string) => {
    if (!value.trim()) return;
    setError(null);
    setNotice(null);
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard_unavailable");
      await navigator.clipboard.writeText(value);
      setNotice(successMessage);
    } catch {
      setError("浏览器没有允许复制。请选中纪要文字后手动复制。");
    }
  };

  const dirty = Boolean(draft && editing && bodyMarkdown !== draft.bodyMarkdown);

  useEffect(() => {
    if (!dirty) return;
    const message = "会后纪要还有未保存的修改，确定离开吗？";
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = message;
    };
    const guardLink = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!target || target.href === globalThis.location.href || globalThis.confirm(message)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    globalThis.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", guardLink, true);
    return () => {
      globalThis.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", guardLink, true);
    };
  }, [dirty]);

  return {
    bodyMarkdown,
    busyAction,
    draft,
    dirty,
    editing,
    error,
    loadState,
    notice,
    sourceStats,
    versionConflict,
    cancelEditing: () => {
      setBodyMarkdown(draft?.bodyMarkdown ?? "");
      setEditing(false);
      setError(null);
      setNotice(null);
      setVersionConflict(false);
    },
    changeBody: (event) => {
      setBodyMarkdown(event.currentTarget.value);
      setError(null);
      setNotice(null);
    },
    copy,
    generate,
    reload: () => {
      preserveBodyOnNextLoadRef.current = false;
      setLoadState("idle");
      setError(null);
      setNotice(null);
      setEditing(false);
      setVersionConflict(false);
      setLoadAttempt((value) => value + 1);
    },
    reloadLatest: () => {
      preserveBodyOnNextLoadRef.current = true;
      setLoadState("idle");
      setError(null);
      setNotice(null);
      setLoadAttempt((value) => value + 1);
    },
    reset,
    save,
    startEditing: () => {
      setEditing(true);
      setError(null);
      setNotice(null);
      setVersionConflict(false);
    }
  };
}

function MarkdownDocument({ body }: Readonly<{ body: string }>) {
  const lines = body.split(/\r?\n/u);
  return (
    <div className={styles.followUpDocument}>
      {lines.map((line, index) => {
        const key = `${index}-${line.slice(0, 24)}`;
        if (line.startsWith("### ")) return <h4 key={key}>{line.slice(4)}</h4>;
        if (line.startsWith("## ")) return <h3 key={key}>{line.slice(3)}</h3>;
        if (line.startsWith("# ")) return <h2 key={key}>{line.slice(2)}</h2>;
        if (line.startsWith("- ")) return <p className={styles.followUpListItem} key={key}>{line.slice(2)}</p>;
        if (!line.trim()) return <span aria-hidden="true" className={styles.followUpSpacer} key={key} />;
        return <p key={key}>{line}</p>;
      })}
    </div>
  );
}

export function WorkMeetingResultStats({
  stats
}: Readonly<{
  stats: WorkMeetingFollowUpGetResponse["sourceStats"];
}>) {
  return (
    <section aria-label="本次会议整理统计" className={styles.meetingResultStats}>
      <p><strong>{stats.confirmedResultCount}</strong><span>项会议结果已确认</span></p>
      <p><strong>{stats.myTodoCount}</strong><span>项我的待办已创建</span></p>
      <p><strong>{stats.waitingForOtherTodoCount}</strong><span>项等待他人已创建</span></p>
      <p><strong>{stats.unresolvedQuestionCount}</strong><span>个未解决问题已保留</span></p>
    </section>
  );
}

export function WorkMeetingFollowUpPanel({
  eligible,
  followUp
}: Readonly<{
  eligible: boolean;
  followUp: WorkMeetingFollowUpState;
}>) {
  const [confirmAction, setConfirmAction] = useState<FollowUpConfirmAction>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const wasEditingRef = useRef(false);

  useEffect(() => {
    if (followUp.editing) textareaRef.current?.focus();
    else if (wasEditingRef.current) editButtonRef.current?.focus();
    wasEditingRef.current = followUp.editing;
  }, [followUp.editing]);

  if (!eligible) {
    return (
      <ProductState
        description="先核对并完成本次会议整理；系统只会使用已确认的会议结果与已创建的关联待办。"
        title="完成会议整理后可以生成纪要"
        tone="empty"
      />
    );
  }
  if (followUp.loadState === "idle" || followUp.loadState === "loading") {
    return <ProductState title="正在读取会后纪要…" tone="loading" />;
  }
  if (followUp.loadState === "error") {
    return (
      <ProductState
        action={<button className={styles.secondaryButton} onClick={followUp.reload} type="button">重新加载</button>}
        description={followUp.error ?? undefined}
        title="暂时无法读取会后纪要"
        tone="error"
      />
    );
  }
  if (!followUp.draft) {
    return (
      <ProductState
        action={(
          <button className={styles.primaryButton} disabled={followUp.busyAction !== null} onClick={() => void followUp.generate()} type="button">
            {followUp.busyAction === "generate" ? "正在生成…" : "生成会后纪要"}
          </button>
        )}
        description="系统会读取已确认的会议结果、关联待办、未解决问题与方案变化；不会使用待确认或已忽略的候选。"
        title="还没有会后纪要"
        tone="empty"
      />
    );
  }

  const draft = followUp.draft;
  const dirty = followUp.bodyMarkdown !== draft.bodyMarkdown;
  const busy = followUp.busyAction !== null;
  return (
    <div aria-busy={busy} className={styles.followUpPanel}>
      <header className={styles.followUpHeader}>
        <div>
          <div className={styles.followUpTitleLine}>
            <h2>会后纪要</h2>
            <span>草稿</span>
          </div>
          <p>这份草稿不会自动发送。编辑只影响纪要，不会改写会议结果、原文或待办。</p>
        </div>
        <span className={styles.followUpVersion}>版本 {draft.version + 1}</span>
      </header>

      {draft.stale ? (
        <section className={styles.followUpStale} role="status">
          <h3>会议结果或待办后来发生变化</h3>
          <p>当前草稿没有被自动覆盖。确认变化后，你可以主动重新生成。</p>
        </section>
      ) : null}
      {followUp.error ? (
        <div className={styles.followUpError} role="alert">
          <p className={styles.formError}>{followUp.error}</p>
          {followUp.versionConflict ? (
            <button className={styles.secondaryButton} onClick={followUp.reloadLatest} type="button">
              保留文字并载入最新版本
            </button>
          ) : null}
        </div>
      ) : null}
      <p aria-live="polite" className={styles.followUpNotice}>{followUp.notice}</p>

      {followUp.editing ? (
        <div className={styles.followUpEditor}>
          <label htmlFor="work-follow-up-body">纪要正文</label>
          <textarea
            aria-describedby="work-follow-up-editor-hint"
            id="work-follow-up-body"
            maxLength={100_000}
            onChange={followUp.changeBody}
            ref={textareaRef}
            value={followUp.bodyMarkdown}
          />
          <p id="work-follow-up-editor-hint">保留标题与分段可以让纪要更容易阅读；最多 100,000 个字符。</p>
          <div className={styles.followUpEditorActions}>
            <button className={styles.primaryButton} disabled={busy || !dirty || !followUp.bodyMarkdown.trim()} onClick={() => void followUp.save()} type="button">
              {followUp.busyAction === "save" ? "正在保存…" : "保存修改"}
            </button>
            <button className={styles.secondaryButton} disabled={busy} onClick={followUp.cancelEditing} type="button">取消编辑</button>
          </div>
        </div>
      ) : (
        <MarkdownDocument body={followUp.bodyMarkdown} />
      )}

      <div className={styles.followUpActions}>
        {!followUp.editing ? <button className={styles.primaryButton} disabled={busy} onClick={followUp.startEditing} ref={editButtonRef} type="button">编辑纪要</button> : null}
        <button className={styles.secondaryButton} disabled={busy} onClick={() => void followUp.copy(followUp.bodyMarkdown, "已复制纪要全文。") } type="button">复制全文</button>
        <button className={styles.secondaryButton} disabled={busy || !draft.copySlices.decisions} onClick={() => void followUp.copy(draft.copySlices.decisions, "已复制决定部分。") } type="button">只复制决定</button>
        <button className={styles.secondaryButton} disabled={busy || !draft.copySlices.actions} onClick={() => void followUp.copy(draft.copySlices.actions, "已复制行动事项。") } type="button">只复制行动事项</button>
        <button className={styles.tertiaryButton} disabled={busy} onClick={() => setConfirmAction("reset")} type="button">恢复系统版本</button>
        <button className={styles.tertiaryButton} disabled={busy} onClick={() => setConfirmAction("regenerate")} type="button">重新生成</button>
      </div>
      <p className={styles.followUpCopyNote}>选择性复制来自最近一次系统生成版本；“复制全文”使用当前屏幕上的草稿正文。</p>

      <ProductDialog
        footer={(
          <>
            <button className={styles.secondaryButton} onClick={() => setConfirmAction(null)} type="button">取消</button>
            <button
              className={styles.primaryButton}
              onClick={() => {
                const action = confirmAction;
                setConfirmAction(null);
                if (action === "reset") void followUp.reset();
                if (action === "regenerate") void followUp.generate();
              }}
              type="button"
            >确认{confirmAction === "reset" ? "恢复" : "重新生成"}</button>
          </>
        )}
        onClose={() => setConfirmAction(null)}
        open={Boolean(confirmAction)}
        title={confirmAction === "reset" ? "恢复最近的系统版本？" : "按最新内容重新生成？"}
      >
        <p className={styles.deleteCopy}>
          {confirmAction === "reset"
            ? "当前编辑内容会被最近一次系统生成版本替换。会议结果、待办和原文不会改变。"
            : "当前草稿会被最新会议结果与待办重新生成的版本替换；这不会自动发送纪要。"}
        </p>
      </ProductDialog>
    </div>
  );
}
