"use client";
import { useEffect, useRef, useState } from "react";
import type { LearningPage } from "@/lib/domain/learning";
import { LearningApiError, learningApi, learningErrorMessage } from "@/lib/client/learning-api";
import styles from "./learning.module.css";
export function LearningAudio({ page, selected, disabled, onUpdated, saveSelection }: {
  page: LearningPage; selected: string[]; disabled: boolean; onUpdated: (page: LearningPage) => void; saveSelection: () => Promise<void>;
}) {
  const [starting, setStarting] = useState(false); const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState<{ id: string; materialIds: string[] } | null>(null);
  const inFlight = useRef(false); const alive = useRef(true); const latest = useRef(onUpdated); latest.current = onUpdated;
  const active = page.materials.some((m) => m.audio?.transcription === "processing");
  const ids = page.materials.filter((m) => selected.includes(m.id) && m.kind === "audio" && m.audio?.transcription !== "completed").map((m) => m.id);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!active && !starting && !uncertain) return;
    const controller = new AbortController(); let reading = false;
    const timer = setInterval(() => {
      if (reading) return; reading = true;
      void learningApi.transcriptions(page.id, controller.signal).then(async ({ runs }) => {
        const result = await learningApi.get(page.id, controller.signal);
        if (!controller.signal.aborted) { latest.current(result.page); if (uncertain && runs.some((r) => r.id === uncertain.id)) setUncertain(null); }
      }).catch((e) => { if (!controller.signal.aborted) setError(learningErrorMessage(e)); }).finally(() => { reading = false; });
    }, 1500);
    return () => { controller.abort(); clearInterval(timer); };
  }, [active, starting, uncertain, page.id]);
  if (!page.materials.some((m) => m.kind === "audio")) return null;
  return <section className={styles.section} aria-label="录音转写">
    <h2>录音转写</h2><p className={styles.muted}>只转写选定的录音。原音保留，目前不支持回听；转写可能有错词，请核对后使用。</p>
    <button type="button" disabled={disabled || starting || active || (!ids.length && !uncertain)} onClick={async () => {
      if (inFlight.current) return; inFlight.current = true; setStarting(true); setError("");
      const request = uncertain ?? { id: crypto.randomUUID(), materialIds: ids };
      try {
        await saveSelection(); setUncertain(request);
        const result = await learningApi.transcribe(page.id, request.id, request.materialIds);
        if (alive.current) { latest.current(result.page); setUncertain(null); }
      } catch (e) {
        if (alive.current) {
          setError(learningErrorMessage(e));
          if (e instanceof LearningApiError && (e.code === "learning_asr_not_configured" || [400, 401, 403, 404, 410, 413, 422].includes(e.status))) setUncertain(null);
        }
      }
      finally { inFlight.current = false; if (alive.current) setStarting(false); }
    }}>{starting || active ? "正在转写…" : uncertain ? "核对本次转写" : "转写所选录音"}</button>
    <ul>{page.materials.filter((m) => m.audio).map((m) => <li key={m.id}>{m.title}：{m.audio!.transcription === "completed" ? "转写已保存" : m.audio!.transcription === "processing" ? "处理中" : m.audio!.transcription === "failed" ? "转写未完成，原音已保留" : "原音已保存，尚未转写"}
      {m.audio!.totalChunks > 0 ? ` · 已完成 ${m.audio!.completedChunks}/${m.audio!.totalChunks} 段` : ""}
      {m.audio!.failure ? <span> · {learningErrorMessage(new LearningApiError(422, m.audio!.failure))}</span> : null}</li>)}</ul>
    {error ? <p role="alert">{error}</p> : null}
    <details><summary>转写与恢复说明</summary><p className={styles.muted}>恢复时保留已完成部分。结果尚未确认时会核对原请求，不会自动重复转写；如服务已无法查询，需要进一步核对。</p></details>
  </section>;
}
