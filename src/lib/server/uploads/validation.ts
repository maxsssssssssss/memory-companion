import { isSupportedAudioUpload } from "@/lib/audio/compat";

const DEFAULT_MAX_UPLOAD_BYTES = 300 * 1024 * 1024;

function formatUploadLimit(bytes: number) {
  return Math.floor(bytes / 1024 / 1024);
}

export type UploadLike = {
  name: string;
  type: string;
  size: number;
};

export type UploadValidationResult =
  | { ok: true }
  | { ok: false; errorCode: "unsupported_audio_format" | "file_too_large" | "empty_file"; message: string };

export function getMaxUploadBytes() {
  const parsed = Number(process.env.MAX_UPLOAD_BYTES);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_UPLOAD_BYTES;
}

export function validateAudioUpload(file: UploadLike): UploadValidationResult {
  if (file.size <= 0) {
    return { ok: false, errorCode: "empty_file", message: "上传文件为空。" };
  }

  if (file.size > getMaxUploadBytes()) {
    return { ok: false, errorCode: "file_too_large", message: `单个音频最大支持 ${formatUploadLimit(getMaxUploadBytes())}MB。` };
  }

  if (!isSupportedAudioUpload(file)) {
    return { ok: false, errorCode: "unsupported_audio_format", message: "不支持该音频格式。" };
  }

  return { ok: true };
}
