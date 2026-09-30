"use client";

import Link from "next/link";
import {
  type FormEvent,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";

import {
  ProductDialog,
  ProductState
} from "@/components/product-system/product-primitives";
import {
  isDefinitiveWorkReviewApiError,
  WorkReviewApiError,
  type WorkReviewApi,
  type WorkReviewV2CoreApi
} from "@/lib/client/work-review-api";

import styles from "./work-project.module.css";
import workStyles from "./work-review.module.css";
import { WorkReviewContext } from "./work-review-shell";
import { asWorkReviewV2Api, workReviewOperationKey } from "./work-review-v2";

type WorkProjectRecord = Awaited<ReturnType<WorkReviewV2CoreApi["listProjects"]>>[number];

function sortProjects(records: readonly WorkProjectRecord[]) {
  return [...records].sort((left, right) => (
    left.name.localeCompare(right.name, "zh-CN", { sensitivity: "base" })
  ));
}

function projectError(error: unknown, fallback: string) {
  if (error instanceof WorkReviewApiError && error.status === 409) {
    return "这个项目已在其他页面更新。请重新载入项目后再操作。";
  }
  return error instanceof WorkReviewApiError ? error.message : fallback;
}

function ProjectEditorDialog({
  error,
  mode,
  onClose,
  onSubmit,
  open,
  project
}: Readonly<{
  error: string | null;
  mode: "create" | "edit";
  onClose: () => void;
  onSubmit: (value: { name: string; description: string | null }) => Promise<void>;
  open: boolean;
  project: WorkProjectRecord | null;
}>) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(project?.name ?? "");
    setDescription(project?.description ?? "");
    setLocalError(null);
  }, [open, project]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    const cleanName = name.trim();
    if (!cleanName) {
      setLocalError("请填写项目名称。");
      return;
    }
    setSaving(true);
    setLocalError(null);
    try {
      await onSubmit({ name: cleanName, description: description.trim() || null });
    } catch {
      // The page owns server-safe error copy and idempotent retry behavior.
    } finally {
      setSaving(false);
    }
  };

  return (
    <ProductDialog
      footer={(
        <div className={styles.dialogActions}>
          <button className={workStyles.secondaryButton} disabled={saving} onClick={onClose} type="button">取消</button>
          <button className={workStyles.primaryButton} disabled={saving} form="work-project-editor" type="submit">
            {saving ? "正在保存…" : mode === "edit" ? "保存修改" : "创建项目"}
          </button>
        </div>
      )}
      onClose={onClose}
      open={open}
      title={mode === "edit" ? "编辑项目" : "新建项目"}
    >
      <form aria-busy={saving} className={styles.projectForm} id="work-project-editor" onSubmit={submit}>
        <label>
          <span>项目名称 <small>{name.length}/120</small></span>
          <input
            autoComplete="off"
            disabled={saving}
            maxLength={120}
            onChange={(event) => setName(event.target.value)}
            required
            value={name}
          />
        </label>
        <label>
          <span>说明 <small>可选 · {description.length}/2000</small></span>
          <textarea
            disabled={saving}
            maxLength={2_000}
            onChange={(event) => setDescription(event.target.value)}
            rows={5}
            value={description}
          />
        </label>
        {localError || error ? <p className={workStyles.formError} role="alert">{localError ?? error}</p> : null}
      </form>
    </ProductDialog>
  );
}

export function WorkProjectsPage({ api: apiOverride }: Readonly<{
  api?: WorkReviewApi;
}> = {}) {
  const context = useContext(WorkReviewContext);
  const api = apiOverride ?? context?.api;
  if (!api) throw new Error("WorkProjectsPage requires an API");
  const v2Api = useMemo(() => asWorkReviewV2Api(api), [api]);
  const [state, setState] = useState<"loading" | "ready" | "disabled" | "error">("loading");
  const [projects, setProjects] = useState<WorkProjectRecord[]>([]);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [dialog, setDialog] = useState<
    | { mode: "create"; project: null }
    | { mode: "edit"; project: WorkProjectRecord }
    | null
  >(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [statusDialog, setStatusDialog] = useState<{
    project: WorkProjectRecord;
    status: "active" | "archived" | "deleted";
  } | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusSaving, setStatusSaving] = useState(false);
  const statusSavingRef = useRef(false);
  const [notice, setNotice] = useState<string | null>(null);
  const operationKeysRef = useRef(new Map<string, string>());

  const keyFor = (logicalKey: string, prefix: string) => {
    const current = operationKeysRef.current.get(logicalKey);
    if (current) return current;
    const next = workReviewOperationKey(prefix);
    operationKeysRef.current.set(logicalKey, next);
    return next;
  };
  const settle = (logicalKey: string, error?: unknown) => {
    if (!error || isDefinitiveWorkReviewApiError(error)) operationKeysRef.current.delete(logicalKey);
  };

  useEffect(() => {
    if (!v2Api) {
      setState("error");
      return;
    }
    const controller = new AbortController();
    setState("loading");
    setNotice(null);
    void v2Api.getCapabilities(controller.signal).then(async (capabilities) => {
      if (controller.signal.aborted) return;
      if (!capabilities.projects) {
        setState("disabled");
        return;
      }
      const records = await v2Api.listProjects("all", controller.signal);
      if (controller.signal.aborted) return;
      setProjects(sortProjects(records));
      setState("ready");
    }).catch((error: unknown) => {
      if (controller.signal.aborted || error instanceof DOMException && error.name === "AbortError") return;
      setState("error");
    });
    return () => controller.abort();
  }, [loadAttempt, v2Api]);

  const activeProjects = projects.filter((project) => project.status === "active");
  const archivedProjects = projects.filter((project) => project.status === "archived");
  const replaceProject = (next: WorkProjectRecord) => {
    setProjects((current) => sortProjects([
      ...current.filter((project) => project.id !== next.id),
      next
    ]));
  };

  if (state === "loading") {
    return <main className={workStyles.page}><ProductState title="正在读取项目…" tone="loading" /></main>;
  }
  if (state === "disabled") {
    return (
      <main className={workStyles.page}>
        <ProductState
          action={<Link className={workStyles.secondaryButton} href="/work-review/meetings">返回会议</Link>}
          description="会议和待办仍可继续使用；项目字段当前不会显示。"
          title="项目整理暂未开放"
          tone="status"
        />
      </main>
    );
  }
  if (state === "error" || !v2Api) {
    return (
      <main className={workStyles.page}>
        <ProductState
          action={v2Api ? <button className={workStyles.secondaryButton} onClick={() => setLoadAttempt((value) => value + 1)} type="button">重新加载</button> : undefined}
          description={v2Api ? "项目没有加载完成，请检查网络后重试。" : "当前客户端还没有完整的项目合同；现有会议和待办不会受影响。"}
          title="暂时无法进入项目管理"
          tone="error"
        />
      </main>
    );
  }

  const renderProjectRow = (project: WorkProjectRecord) => (
    <li className={styles.projectRow} key={project.id}>
      <div>
        <h3>{project.name}</h3>
        {project.description ? <p>{project.description}</p> : <small>没有补充说明</small>}
      </div>
      <div className={styles.projectActions}>
        {project.status === "active" ? (
          <button
            className={workStyles.secondaryButton}
            onClick={() => { setEditorError(null); setDialog({ mode: "edit", project }); }}
            type="button"
          >编辑</button>
        ) : null}
        <button
          className={project.status === "active" ? workStyles.tertiaryButton : workStyles.secondaryButton}
          onClick={() => {
            setStatusError(null);
            setStatusDialog({ project, status: project.status === "active" ? "archived" : "active" });
          }}
          type="button"
        >{project.status === "active" ? "归档" : "恢复"}</button>
        {project.status === "archived" && v2Api.deleteProject ? (
          <button
            className={workStyles.dangerButton}
            onClick={() => {
              setStatusError(null);
              setStatusDialog({ project, status: "deleted" });
            }}
            type="button"
          >删除</button>
        ) : null}
      </div>
    </li>
  );

  return (
    <main className={workStyles.page}>
      <Link className={workStyles.backLink} href="/work-review/meetings">← 返回会议</Link>
      <header className={styles.projectPageHeader}>
        <div>
          <h1>项目</h1>
          <p>用轻量项目归类会议与待办。项目只帮助整理和筛选，不包含成员、进度或绩效。</p>
        </div>
        <button className={workStyles.primaryButton} onClick={() => { setEditorError(null); setDialog({ mode: "create", project: null }); }} type="button">新建项目</button>
      </header>
      {notice ? <p aria-live="polite" className={workStyles.inlineNotice}>{notice}</p> : null}
      <div className={styles.projectSections}>
        <section aria-labelledby="active-projects-title" className={styles.projectSection}>
          <header>
            <h2 id="active-projects-title">使用中的项目</h2>
            <p>这些项目会出现在新的会议和待办选择器中。</p>
          </header>
          {activeProjects.length ? (
            <ul className={styles.projectList}>{activeProjects.map(renderProjectRow)}</ul>
          ) : (
            <ProductState
              action={<button className={workStyles.secondaryButton} onClick={() => { setEditorError(null); setDialog({ mode: "create", project: null }); }} type="button">创建第一个项目</button>}
              description="你仍然可以让会议和待办保持未分类。"
              title="还没有使用中的项目"
              tone="empty"
            />
          )}
        </section>
        <section aria-labelledby="archived-projects-title" className={styles.projectSection}>
          <header>
            <h2 id="archived-projects-title">已归档项目</h2>
            <p>历史关联会继续保留；恢复后才会重新出现在新的关联选项中。</p>
          </header>
          {archivedProjects.length ? (
            <ul className={styles.projectList}>{archivedProjects.map(renderProjectRow)}</ul>
          ) : (
            <ProductState description="归档项目会保留历史会议和待办关联。" title="还没有归档项目" tone="empty" />
          )}
        </section>
      </div>
      <ProjectEditorDialog
        error={editorError}
        mode={dialog?.mode ?? "create"}
        onClose={() => setDialog(null)}
        onSubmit={async ({ name, description }) => {
          const project = dialog?.project ?? null;
          const logicalKey = `${dialog?.mode ?? "create"}:${project?.id ?? "new"}:${project?.version ?? 0}:${name}:${description ?? ""}`;
          const operationKey = keyFor(logicalKey, dialog?.mode === "edit" ? "edit-project" : "create-project");
          setEditorError(null);
          try {
            const next = dialog?.mode === "edit" && project
              ? await v2Api.updateProject(project.id, {
                description,
                expectedVersion: project.version,
                name,
                operationKey
              })
              : await v2Api.createProject({ description, name, operationKey });
            settle(logicalKey);
            replaceProject(next);
            setDialog(null);
            setNotice(dialog?.mode === "edit" ? "项目修改已保存。" : "项目已创建。你现在可以把会议和待办归入这个项目。");
          } catch (error) {
            settle(logicalKey, error);
            setEditorError(projectError(error, "暂时无法保存项目，请稍后重试。"));
            throw error;
          }
        }}
        open={Boolean(dialog)}
        project={dialog?.project ?? null}
      />
      <ProductDialog
        footer={(
          <div className={styles.dialogActions}>
            <button className={workStyles.secondaryButton} disabled={statusSaving} onClick={() => setStatusDialog(null)} type="button">取消</button>
            <button
              className={statusDialog?.status === "active" ? workStyles.primaryButton : workStyles.dangerButton}
              disabled={statusSaving}
              onClick={() => {
                if (!statusDialog || statusSavingRef.current) return;
                const { project, status } = statusDialog;
                if (status === "deleted" && !v2Api.deleteProject) return;
                const logicalKey = `status:${project.id}:${project.version}:${status}`;
                statusSavingRef.current = true;
                setStatusSaving(true);
                setStatusError(null);
                const mutation = status === "deleted"
                  ? v2Api.deleteProject!(project.id, { expectedVersion: project.version })
                  : v2Api.updateProject(project.id, {
                    expectedVersion: project.version,
                    operationKey: keyFor(logicalKey, status === "archived" ? "archive-project" : "restore-project"),
                    status
                  });
                void mutation.then((next) => {
                  settle(logicalKey);
                  if (status === "deleted") {
                    setProjects((current) => current.filter((value) => value.id !== project.id));
                  } else if (next) {
                    replaceProject(next);
                  }
                  setStatusDialog(null);
                  setNotice(status === "deleted"
                    ? "项目已删除；会议、待办和已有周回顾仍然保留。"
                    : status === "archived"
                    ? "项目已归档；历史会议和待办关联仍然保留。"
                    : "项目已恢复，可以用于新的会议和待办。"
                  );
                }).catch((error: unknown) => {
                  settle(logicalKey, error);
                  setStatusError(projectError(error, status === "deleted" ? "暂时无法删除项目，请稍后重试。" : status === "archived" ? "暂时无法归档项目。" : "暂时无法恢复项目。"));
                }).finally(() => {
                  statusSavingRef.current = false;
                  setStatusSaving(false);
                });
              }}
              type="button"
            >{statusSaving ? "正在处理…" : statusDialog?.status === "deleted" ? "确认删除" : statusDialog?.status === "archived" ? "确认归档" : "确认恢复"}</button>
          </div>
        )}
        onClose={() => { if (!statusSavingRef.current) setStatusDialog(null); }}
        open={Boolean(statusDialog)}
        title={statusDialog?.status === "deleted" ? "删除这个项目吗？" : statusDialog?.status === "archived" ? "归档这个项目吗？" : "恢复这个项目吗？"}
      >
        <div className={styles.statusCopy}>
          <strong>{statusDialog?.project.name}</strong>
          <p>{statusDialog?.status === "deleted"
            ? "删除后无法恢复。项目与会议、待办的关联将被解除，会议、待办和已有周回顾仍然保留。"
            : statusDialog?.status === "archived"
            ? "归档后，它不会出现在新的关联选项中；已有会议和待办关联不会被移除。"
            : "恢复后，它会重新出现在新的会议和待办关联选项中。"
          }</p>
          {statusError ? <p className={workStyles.formError} role="alert">{statusError}</p> : null}
          {statusError ? <button className={workStyles.secondaryButton} disabled={statusSaving} onClick={() => {
            setStatusDialog(null);
            setLoadAttempt((value) => value + 1);
          }} type="button">重新载入项目</button> : null}
        </div>
      </ProductDialog>
    </main>
  );
}
