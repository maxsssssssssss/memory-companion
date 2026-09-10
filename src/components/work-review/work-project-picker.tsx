"use client";

import Link from "next/link";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import {
  WorkReviewApiError,
  type WorkMeetingListItem,
  type WorkReviewApi,
  type WorkReviewV2CoreApi
} from "@/lib/client/work-review-api";

import workStyles from "./work-review.module.css";
import { asWorkReviewV2Api } from "./work-review-v2";
import styles from "./work-project.module.css";

type WorkProjectRecord = Awaited<ReturnType<WorkReviewV2CoreApi["listProjects"]>>[number];
type WorkProjectReference = NonNullable<WorkMeetingListItem["projects"]>[number];
type WorkProjectScopeFilter = Parameters<WorkReviewV2CoreApi["listMeetingsByProject"]>[0];

function projectLoadError(error: unknown) {
  return error instanceof WorkReviewApiError
    ? error.message
    : "暂时无法读取项目，请稍后重试。";
}

export function WorkProjectPicker({
  api,
  defaultProjectIds = [],
  disabled = false,
  label = "关联项目",
  onChange,
  selectedIds
}: Readonly<{
  api: WorkReviewApi;
  defaultProjectIds?: readonly string[];
  disabled?: boolean;
  label?: string;
  onChange: (projectIds: string[]) => void;
  selectedIds: readonly string[];
}>) {
  const v2Api = useMemo(() => asWorkReviewV2Api(api), [api]);
  const [projects, setProjects] = useState<WorkProjectRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const defaultsAppliedRef = useRef(false);
  const defaultIdsKey = JSON.stringify(defaultProjectIds);
  const helpId = useId();
  const panelId = useId();
  const [expanded, setExpanded] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (defaultsAppliedRef.current || selectedIds.length || defaultIdsKey === "[]") return;
    defaultsAppliedRef.current = true;
    onChange(JSON.parse(defaultIdsKey) as string[]);
  }, [defaultIdsKey, onChange, selectedIds.length]);

  useEffect(() => {
    if (!v2Api) return;
    const controller = new AbortController();
    setProjects(null);
    setError(null);
    void v2Api.listProjects("all", controller.signal).then((records) => {
      if (!controller.signal.aborted) setProjects(records);
    }).catch((loadError: unknown) => {
      if (controller.signal.aborted || loadError instanceof DOMException && loadError.name === "AbortError") return;
      setError(projectLoadError(loadError));
    });
    return () => controller.abort();
  }, [attempt, v2Api]);

  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const visibleProjects = useMemo(() => projects?.filter((project) => (
    project.status === "active" || selected.has(project.id)
  )) ?? [], [projects, selected]);
  const atLimit = selectedIds.length >= 3;
  const selectionLabel = selectedIds.length
    ? selectedIds.map((id) => projects?.find((project) => project.id === id)?.name ?? "已关联项目").join("、")
    : "选择项目";

  return (
    <fieldset className={styles.projectPicker} disabled={disabled}>
      <legend>{label}</legend>
      <button
        aria-controls={panelId}
        aria-expanded={expanded}
        aria-label={`${label}：${selectionLabel}`}
        className={styles.pickerTrigger}
        onClick={() => setExpanded((value) => !value)}
        ref={triggerRef}
        type="button"
      >
        <span>{selectionLabel}</span>
        <small>{error ? "读取失败" : `${selectedIds.length}/3`}</small>
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d={expanded ? "m6 15 6-6 6 6" : "m6 9 6 6 6-6"} /></svg>
      </button>
      <div className={styles.pickerPanel} hidden={!expanded} id={panelId} onKeyDownCapture={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        // Consume the inner dismissal before the dialog's native document listener.
        event.stopPropagation();
        event.nativeEvent.stopImmediatePropagation();
        setExpanded(false);
        triggerRef.current?.focus();
      }}>
      <div className={styles.pickerHeading}>
        <p id={helpId}>
          最多选择 3 个。归档项目不会出现在新选项中，但已有归档关联可以移除。
        </p>
        <span aria-live="polite">已选 {selectedIds.length}/3</span>
      </div>
      {!v2Api ? (
        <p className={styles.pickerNotice} role="status">项目服务尚未准备好，当前项目关联保持不变。</p>
      ) : error ? (
        <div className={styles.pickerFailure} role="alert">
          <p>{error}</p>
          <button
            className={workStyles.secondaryButton}
            disabled={disabled}
            onClick={() => setAttempt((value) => value + 1)}
            type="button"
          >重新读取项目</button>
        </div>
      ) : projects === null ? (
        <p className={styles.pickerNotice} role="status">
          正在读取项目{selectedIds.length ? `；当前保留 ${selectedIds.length} 个已选项目` : ""}…
        </p>
      ) : visibleProjects.length ? (
        <div aria-describedby={helpId} className={styles.projectChoices}>
          {visibleProjects.map((project) => {
            const checked = selected.has(project.id);
            return (
              <label key={project.id}>
                <input
                  checked={checked}
                  disabled={disabled || !checked && atLimit}
                  onChange={(event) => {
                    if (event.target.checked) onChange([...selectedIds, project.id]);
                    else onChange(selectedIds.filter((projectId) => projectId !== project.id));
                  }}
                  type="checkbox"
                />
                <span>
                  <b>{project.name}</b>
                  {project.status === "archived" ? <small>已归档 · 可移除</small> : null}
                </span>
              </label>
            );
          })}
        </div>
      ) : (
        <p className={styles.pickerNotice}>还没有使用中的项目。你也可以暂时保持未分类。</p>
      )}
      {atLimit ? <p className={styles.limitNotice}>已达到 3 个项目上限；移除一个后才能继续选择。</p> : null}
      <Link className={styles.manageProjectsLink} href="/work-review/projects">管理项目</Link>
      </div>
    </fieldset>
  );
}

export function WorkProjectFilter({
  disabled = false,
  onChange,
  projects,
  value
}: Readonly<{
  disabled?: boolean;
  onChange: (value: WorkProjectScopeFilter) => void;
  projects: readonly WorkProjectReference[];
  value: WorkProjectScopeFilter;
}>) {
  const selectedValue = value.kind === "project" ? `project:${value.projectId}` : value.kind;
  return (
    <label className={styles.projectFilter}>
      <span>项目范围</span>
      <select
        disabled={disabled}
        onChange={(event) => {
          const next = event.target.value;
          if (next === "all" || next === "unassigned") onChange({ kind: next });
          else onChange({ kind: "project", projectId: next.slice("project:".length) });
        }}
        value={selectedValue}
      >
        <option value="all">全部项目</option>
        <option value="unassigned">未分类</option>
        {projects.map((project) => (
          <option key={project.id} value={`project:${project.id}`}>
            {project.name}{project.status === "archived" ? "（已归档）" : ""}
          </option>
        ))}
      </select>
    </label>
  );
}

export function WorkProjectBadges({ projects }: Readonly<{
  projects: readonly WorkProjectReference[];
}>) {
  if (!projects.length) return null;
  return (
    <span aria-label="关联项目" className={styles.projectBadges}>
      {projects.map((project) => (
        <span data-archived={project.status === "archived"} key={project.id}>
          {project.name}{project.status === "archived" ? " · 已归档" : ""}
        </span>
      ))}
    </span>
  );
}
