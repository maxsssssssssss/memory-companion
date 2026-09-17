import type { DailyReflectionOperationUploadState, DailyReflectionUploadFailure } from "@/lib/domain/daily-reflection-api";

export function activeUploadFailure(state: DailyReflectionOperationUploadState | null | undefined,
  failure: DailyReflectionUploadFailure | null | undefined) {
  return state === "accepted" || state === "terminated" || state === "still_persisting" ? null : failure ?? null;
}

export function reflectionUploadLabel(state: DailyReflectionOperationUploadState | null | undefined,
  failure: DailyReflectionUploadFailure | null | undefined, status?: string): string | null {
  if (state === "still_persisting") return "服务器正在保存录音";
  if (state === "accepted") return status === "created" || status === "uploading" ? "录音已保存，等待整理" : null;
  if (state === "terminated") return null;
  if (failure) return "录音保存失败";
  return state === "unresolved" || state === "reupload_allowed" || status === "created" || status === "uploading" ? "录音保存尚未确认" : null;
}
