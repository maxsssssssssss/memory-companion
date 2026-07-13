import { getOpenRouterErrorMessage } from "@/lib/openrouter/errors";

type OpenRouterTranscriptionResponse = {
  text?: string;
  usage?: {
    seconds?: number;
  };
  error?: {
    message?: string;
    code?: string | number;
    metadata?: {
      provider_name?: string;
      raw?: string;
    };
  };
  message?: string;
};

const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_MAX_TRANSCRIPTION_CHUNK_BYTES = 192 * 1024;

const mimeTypeToFormat: Record<string, string> = {
  "audio/aac": "aac",
  "audio/flac": "flac",
  "audio/m4a": "m4a",
  "audio/mp3": "mp3",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/mpga": "mpga",
  "audio/ogg": "ogg",
  "audio/opus": "opus",
  "audio/wav": "wav",
  "audio/webm": "webm",
  "audio/x-pcm": "wav",
  "video/mp4": "mp4"
};

function getAudioFormat(file: File) {
  const mappedFormat = mimeTypeToFormat[file.type];
  if (mappedFormat) {
    return mappedFormat;
  }

  const extension = file.name.split(".").pop()?.trim().toLowerCase();
  return extension || "mp3";
}

function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";

  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }

  return btoa(binary);
}

function findNextMp3FrameSync(bytes: Uint8Array, start: number, end: number) {
  const safeStart = Math.max(0, start);
  const safeEnd = Math.min(bytes.length - 1, end);

  for (let index = safeStart; index < safeEnd; index += 1) {
    if (bytes[index] === 0xff && (bytes[index + 1] & 0xe0) === 0xe0) {
      return index;
    }
  }

  return null;
}

function canByteChunkAudioFormat(format: string) {
  return format === "mp3" || format === "mpga";
}

function splitMp3Bytes(bytes: Uint8Array, maxChunkBytes: number) {
  const starts = [0];
  let nextTarget = maxChunkBytes;

  while (nextTarget < bytes.length) {
    const nextSync = findNextMp3FrameSync(bytes, nextTarget, nextTarget + 64 * 1024);
    const nextStart = nextSync ?? nextTarget;

    if (nextStart <= starts[starts.length - 1]) {
      break;
    }

    starts.push(nextStart);
    nextTarget = nextStart + maxChunkBytes;
  }

  return starts
    .map((start, index) => bytes.slice(start, starts[index + 1] ?? bytes.length))
    .filter((chunk) => chunk.byteLength > 0);
}

async function createAudioParts(file: File, maxChunkBytes: number) {
  const format = getAudioFormat(file);
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  if (bytes.byteLength <= maxChunkBytes) {
    return [{ buffer, format }];
  }

  if (!canByteChunkAudioFormat(format)) {
    throw new Error(
      `本地优先模式暂时不能在浏览器里可靠分段 ${format} 长音频。请先转换为 MP3，或切回在线服务模式处理这次录音。`
    );
  }

  return splitMp3Bytes(bytes, maxChunkBytes).map((chunk) => ({
    buffer: chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength),
    format
  }));
}

async function parseOpenRouterResponse(response: Response): Promise<OpenRouterTranscriptionResponse> {
  const rawBody = await response.text();
  if (!rawBody) {
    return {};
  }

  try {
    return JSON.parse(rawBody) as OpenRouterTranscriptionResponse;
  } catch {
    return { message: rawBody };
  }
}

export async function transcribeAudioFileWithOpenRouter(input: {
  file: File;
  apiKey: string;
  model: string;
  baseUrl?: string;
  maxChunkBytes?: number;
}) {
  const baseUrl = (input.baseUrl ?? DEFAULT_OPENROUTER_BASE_URL).replace(/\/+$/, "");
  const parts = await createAudioParts(input.file, input.maxChunkBytes ?? DEFAULT_MAX_TRANSCRIPTION_CHUNK_BYTES);
  const transcriptions: string[] = [];
  let durationSeconds = 0;

  for (const [partIndex, part] of parts.entries()) {
    const audioData = arrayBufferToBase64(part.buffer);
    const response = await fetch(`${baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        input_audio: {
          data: audioData,
          format: part.format
        },
        model: input.model
      })
    });
    const payload = await parseOpenRouterResponse(response);

    if (!response.ok) {
      const chunkSuffix = parts.length > 1 ? ` · chunk=${partIndex + 1}/${parts.length}` : "";
      throw new Error(`OpenRouter transcription failed: ${response.status} ${getOpenRouterErrorMessage(payload, response)}${chunkSuffix}`);
    }

    if (payload.text?.trim()) {
      transcriptions.push(payload.text.trim());
    }
    if (typeof payload.usage?.seconds === "number" && Number.isFinite(payload.usage.seconds)) {
      durationSeconds += payload.usage.seconds;
    }
  }

  return {
    text: transcriptions.join("\n"),
    durationSeconds: durationSeconds > 0 ? durationSeconds : undefined
  };
}
