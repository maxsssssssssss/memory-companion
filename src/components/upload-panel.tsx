"use client";

import { type FormEvent, useState } from "react";

type UploadPanelProps = {
  onUploaded: (uploadId: string) => void;
  defaultRecordingDate: string;
  processingMode?: "online" | "local";
  onLocalAnalyze?: (input: { file: File; recordingDate: string }) => Promise<void>;
};

const MAX_UPLOAD_BYTES = 300 * 1024 * 1024;
const MAX_UPLOAD_MEGABYTES = Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024);

export function formatLocalDateInputValue(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function UploadGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" aria-hidden="true">
      <path d="M12 16V4M7 9l5-5 5 5" />
      <path d="M20 16v3a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-3" />
    </svg>
  );
}

function uploadTooLargeMessage() {
  return `单个音频最大支持 ${MAX_UPLOAD_MEGABYTES}MB。请压缩或拆分后再上传。`;
}

function uploadFailureMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "";

  if (message === "Failed to fetch" || message === "Load failed" || message.includes("NetworkError")) {
    return `上传请求被浏览器或网络中断。请确认网络稳定、文件不超过 ${MAX_UPLOAD_MEGABYTES}MB；如果仍失败，可以稍后重试。`;
  }

  return message || "上传失败，请检查网络后重试。";
}

export function UploadPanel({ onUploaded, defaultRecordingDate, processingMode = "online", onLocalAnalyze }: UploadPanelProps) {
  const [recordingDate, setRecordingDate] = useState(defaultRecordingDate);
  const [selectedFileName, setSelectedFileName] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  const isLocalMode = processingMode === "local";

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const form = event.currentTarget;
    const formData = new FormData(form);
    const fileField = formData.get("file");
    const uploadFile = selectedFile ?? (fileField instanceof File ? fileField : null);
    setErrorMessage("");
    setIsUploading(true);

    try {
      if (!uploadFile) {
        setErrorMessage("请选择音频文件。");
        return;
      }

      if (uploadFile.size > MAX_UPLOAD_BYTES) {
        setErrorMessage(uploadTooLargeMessage());
        return;
      }

      if (isLocalMode) {
        if (!onLocalAnalyze) {
          setErrorMessage("本地优先模式还没有准备好。");
          return;
        }

        await onLocalAnalyze({
          file: uploadFile,
          recordingDate
        });
        form.reset();
        setSelectedFileName("");
        setSelectedFile(null);
        setRecordingDate(defaultRecordingDate);
        return;
      }

      const response = await fetch("/api/uploads", {
        method: "POST",
        body: formData
      });
      const payload = (await response.json()) as { uploadId?: string; message?: string; error?: string };

      if (!response.ok || !payload.uploadId) {
        setErrorMessage(payload.message ?? payload.error ?? "上传失败，请稍后重试。");
        return;
      }

      onUploaded(payload.uploadId);
      form.reset();
      setSelectedFileName("");
      setSelectedFile(null);
      setRecordingDate(defaultRecordingDate);
    } catch (error) {
      setErrorMessage(uploadFailureMessage(error));
    } finally {
      setIsUploading(false);
    }
  }

  return (
    <section className="upload-panel" aria-labelledby="upload-panel-title">
      <h3 id="upload-panel-title">{isLocalMode ? "本地分析今天的录音" : "上传今天的录音"}</h3>
      <p className="sub">
        {isLocalMode
          ? "选择录音日期和音频文件，录音不会上传到服务器，会在当前浏览器中进入本地优先分析流程。"
          : "选择录音日期和音频文件，上传后会自动进入转写与简报提取流程。"}
      </p>

      <form className="upload-form" onSubmit={handleSubmit}>
        <label className="field">
          <span>录音日期</span>
          <input
            name="recordingDate"
            type="date"
            value={recordingDate}
            onChange={(event) => setRecordingDate(event.target.value)}
            required
          />
        </label>

        <label className="drop">
          <input
            className="visually-hidden"
            aria-label="音频文件"
            name="file"
            type="file"
            accept="audio/*,video/mp4,.opus,.pcm"
            onChange={(event) => {
              const file = event.target.files?.[0] ?? null;
              setSelectedFile(file);
              setSelectedFileName(file?.name ?? "");
            }}
            required
          />
          <span className="di">
            <UploadGlyph />
          </span>
          <b>{selectedFileName || "点击或拖拽音频文件到此处"}</b>
          <span>支持 mp3 / m4a / wav / mp4 / opus / pcm，单个文件最高 {MAX_UPLOAD_MEGABYTES}MB</span>
        </label>

        {selectedFileName ? <p className="field-hint">已选择：{selectedFileName}</p> : null}
        {errorMessage ? <p className="form-error">{errorMessage}</p> : null}
        <button className="primary-button" type="submit" disabled={isUploading}>
          {isUploading ? (isLocalMode ? "本地分析中..." : "上传中...") : isLocalMode ? "开始本地分析" : "开始分析"}
        </button>
      </form>
    </section>
  );
}
