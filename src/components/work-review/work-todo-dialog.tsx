"use client";

import { type FormEvent, useEffect, useRef, useState } from "react";

import { ProductDialog } from "@/components/product-system/product-primitives";
import {
  isDefinitiveWorkReviewApiError,
  type WorkMeetingFinding,
  type WorkReviewApi,
  type WorkTodo,
  type WorkTodoDraft,
  type WorkTodoKind
} from "@/lib/client/work-review-api";

import workStyles from "./work-review.module.css";
import { WorkProjectPicker } from "./work-project-picker";
import styles from "./work-todo.module.css";
import { workTodoOperationKey } from "./work-todo-utils";

export type WorkTodoDialogSubmission = WorkTodoDraft & Readonly<{
  operationKey: string;
  ownershipOverrideConfirmed: boolean;
}>;

export function WorkTodoDialog({
  addToTodayDefault = false,
  api,
  defaultProjectIds = [],
  error,
  finding = null,
  initialKind = "self",
  mode,
  onClose,
  onSubmit,
  open,
  projectApi,
  projectsEnabled = false,
  today,
  todo = null
}: Readonly<{
  addToTodayDefault?: boolean;
  api?: WorkReviewApi;
  defaultProjectIds?: readonly string[];
  error?: string | null;
  finding?: WorkMeetingFinding | null;
  initialKind?: WorkTodoKind;
  mode: "create" | "edit" | "projection";
  onClose: () => void;
  onSubmit: (input: WorkTodoDialogSubmission) => Promise<void>;
  open: boolean;
  projectApi?: WorkReviewApi;
  projectsEnabled?: boolean;
  today: string;
  todo?: WorkTodo | null;
}>) {
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<WorkTodoKind>(initialKind);
  const [ownerLabel, setOwnerLabel] = useState("");
  const [currentDueDate, setCurrentDueDate] = useState("");
  const [notes, setNotes] = useState("");
  const [isImportant, setIsImportant] = useState(false);
  const [myDayDate, setMyDayDate] = useState<string | null>(null);
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [ownershipOverrideConfirmed, setOwnershipOverrideConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const operationKeyRef = useRef(workTodoOperationKey("todo"));
  const operationFingerprintRef = useRef<string | null>(null);
  const identity = todo?.id ?? finding?.id ?? mode;
  const defaultProjectIdsKey = JSON.stringify(defaultProjectIds);
  const resolvedProjectApi = projectApi ?? api;

  useEffect(() => {
    if (!open) return;
    const nextKind = todo?.kind ?? initialKind;
    setTitle(todo?.title ?? finding?.title ?? "");
    setKind(nextKind);
    setOwnerLabel(
      todo?.ownerLabel
        ?? (finding?.actionBasis !== "unowned_follow_up" && nextKind === "waiting_for_other"
          ? finding?.candidateOwner ?? ""
          : "")
    );
    setCurrentDueDate(todo?.currentDueDate ?? finding?.dueAt?.slice(0, 10) ?? "");
    setNotes(todo?.notes ?? finding?.body ?? "");
    setIsImportant(todo?.isImportant ?? false);
    setMyDayDate(todo?.myDayDate ?? (addToTodayDefault ? today : null));
    setProjectIds(
      todo?.projects?.map((project) => project.id)
      ?? (JSON.parse(defaultProjectIdsKey) as string[])
    );
    setOwnershipOverrideConfirmed(false);
    setLocalError(null);
    operationKeyRef.current = workTodoOperationKey(mode === "projection" ? "finding-todo" : mode === "edit" ? "edit-todo" : "create-todo");
    operationFingerprintRef.current = null;
  }, [addToTodayDefault, defaultProjectIdsKey, finding, identity, initialKind, mode, open, today, todo]);

  const requiresOwnershipOverride = finding?.actionBasis === "assignment_without_acceptance" && kind === "self";
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    const cleanTitle = title.trim();
    const cleanOwner = ownerLabel.trim();
    if (!cleanTitle) {
      setLocalError("请填写待办标题。");
      return;
    }
    if (kind === "waiting_for_other" && !cleanOwner) {
      setLocalError("请填写负责人或等待对象。");
      return;
    }
    if (requiresOwnershipOverride && !ownershipOverrideConfirmed) {
      setLocalError("请先确认由你接手这项待办。");
      return;
    }
    setSaving(true);
    setLocalError(null);
    const submission = {
      title: cleanTitle,
      kind,
      ownerLabel: kind === "waiting_for_other" ? cleanOwner : null,
      currentDueDate: currentDueDate || null,
      notes: notes.trim() || null,
      isImportant,
      myDayDate,
      projectIds: projectsEnabled ? projectIds : undefined,
      ownershipOverrideConfirmed: requiresOwnershipOverride && ownershipOverrideConfirmed
    };
    const fingerprint = JSON.stringify(submission);
    if (operationFingerprintRef.current !== fingerprint) {
      operationKeyRef.current = workTodoOperationKey(mode === "projection" ? "finding-todo" : mode === "edit" ? "edit-todo" : "create-todo");
      operationFingerprintRef.current = fingerprint;
    }
    try {
      await onSubmit({
        ...submission,
        operationKey: operationKeyRef.current,
      });
    } catch (submitError) {
      if (isDefinitiveWorkReviewApiError(submitError)) {
        operationKeyRef.current = workTodoOperationKey(mode === "projection" ? "finding-todo" : mode === "edit" ? "edit-todo" : "create-todo");
        operationFingerprintRef.current = null;
      }
      // The caller supplies safe error copy. Only uncertain retries keep the same key and payload fingerprint.
    } finally {
      setSaving(false);
    }
  };

  const dialogTitle = mode === "edit"
    ? "编辑待办"
    : mode === "projection"
      ? "从会议结果创建待办"
      : "新建待办";

  if (!open) return null;

  return (
    <div className={styles.todoDialog}>
    <ProductDialog
      footer={(
        <div className={styles.dialogActions}>
          <button className={workStyles.secondaryButton} disabled={saving} onClick={onClose} type="button">取消</button>
          <button className={workStyles.primaryButton} disabled={saving} form="work-todo-editor" type="submit">
            {saving ? "正在保存…" : mode === "edit" ? "保存修改" : "创建待办"}
          </button>
        </div>
      )}
      onClose={onClose}
      open={open}
      title={dialogTitle}
    >
      <form className={styles.todoForm} id="work-todo-editor" onSubmit={submit}>
        {mode === "projection" && finding ? (
          <div className={styles.sourceNotice}>
            <b>来源会议结果</b>
            <span>{finding.title}</span>
            {finding.actionBasis === "suggested_action" ? <small>来源性质：建议事项，不代表任何人已经承诺。</small> : null}
            {finding.actionBasis === "unowned_follow_up" ? <small>原会议没有确认负责人，请由你明确选择。</small> : null}
          </div>
        ) : null}
        <label>
          <span>标题</span>
          <input autoComplete="off" maxLength={240} onChange={(event) => setTitle(event.target.value)} required value={title} />
        </label>
        <fieldset>
          <legend>类型</legend>
          <label><input checked={kind === "self"} name="todoKind" onChange={() => setKind("self")} type="radio" />我的待办</label>
          <label><input checked={kind === "waiting_for_other"} name="todoKind" onChange={() => setKind("waiting_for_other")} type="radio" />等待他人</label>
        </fieldset>
        {kind === "waiting_for_other" ? (
          <label>
            <span>负责人或等待对象</span>
            <input autoComplete="off" maxLength={240} onChange={(event) => setOwnerLabel(event.target.value)} placeholder="例如：Alex、客户、负责人尚未确认" required value={ownerLabel} />
          </label>
        ) : <p className={styles.ownerSelf}>负责人：我</p>}
        <label>
          <span>当前计划日期</span>
          <input onChange={(event) => setCurrentDueDate(event.target.value)} type="date" value={currentDueDate} />
        </label>
        {projectsEnabled ? resolvedProjectApi ? (
          <WorkProjectPicker
            api={resolvedProjectApi}
            defaultProjectIds={defaultProjectIds}
            disabled={saving}
            onChange={setProjectIds}
            selectedIds={projectIds}
          />
        ) : (
          <p className={styles.projectUnavailable} role="status">项目选择暂不可用；当前项目关联会保持不变。</p>
        ) : null}
        <label>
          <span>备注</span>
          <textarea maxLength={5_000} onChange={(event) => setNotes(event.target.value)} rows={4} value={notes} />
        </label>
        <div className={styles.todoChecks}>
          <label><input checked={isImportant} onChange={(event) => setIsImportant(event.target.checked)} type="checkbox" />标记为重要</label>
          <label><input checked={myDayDate === today} onChange={(event) => setMyDayDate(event.target.checked ? today : null)} type="checkbox" />加入今天</label>
        </div>
        {requiresOwnershipOverride ? (
          <label className={styles.ownershipConfirmation}>
            <input checked={ownershipOverrideConfirmed} onChange={(event) => setOwnershipOverrideConfirmed(event.target.checked)} type="checkbox" />
            <span>当前会议记录只显示任务被分配，没有找到你明确接受的表达。仍然加入你的待办吗？</span>
          </label>
        ) : null}
        {mode === "edit" && todo?.origin === "meeting_finding" ? (
          <p className={styles.integrityNote}>这里的修改只影响你的待办，不会修改会议结果、负责人原话或原始日期。</p>
        ) : null}
        {localError || error ? <p className={workStyles.formError} role="alert">{localError ?? error}</p> : null}
      </form>
    </ProductDialog>
    </div>
  );
}
