/**
 * Provider-emitted speaker label for the authenticated user's trained voice.
 * It is meaningful only inside that user's isolated Voiceprint profile store.
 */
export const VOICEPRINT_PROVIDER_KNOWN_USER_LABEL = "我";

export type VoiceprintTrainingAudio = {
  url: string;
  rule: Array<[startMilliseconds: number, endMilliseconds: number]>;
};

export type VoiceprintTrainInput = {
  userId: string;
  audio: VoiceprintTrainingAudio[];
  requestId: string;
};

export type VoiceprintSaveInput = {
  userId: string;
  recordId: string;
  speakerId: string;
  speakerName: string;
  requestId: string;
};

export type VoiceprintIdentifyInput = {
  userId: string;
  recordId: string;
  localSpeakers: string[];
};

export type VoiceprintIdentification = {
  localSpeaker: string;
  globalSpeakerId: string;
  displayName?: string;
  confidence: number;
};

export type VoiceprintOperationResult = {
  code: 0;
  message?: string;
  attemptCount: number;
};

export interface VoiceprintProvider {
  train(input: VoiceprintTrainInput): Promise<VoiceprintOperationResult>;
  save(input: VoiceprintSaveInput): Promise<VoiceprintOperationResult>;
  identify(input: VoiceprintIdentifyInput): Promise<VoiceprintIdentification[]>;
}

export class VoiceprintProviderError extends Error {
  constructor(
    readonly reason:
      | "invalid_configuration"
      | "invalid_request"
      | "network_error"
      | "timeout"
      | "http_error"
      | "invalid_response"
      | "provider_rejected",
    message: string,
    readonly status?: number,
    readonly providerCode?: number,
    readonly attemptCount = 1,
    readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = "VoiceprintProviderError";
  }

  get retryable() {
    return (
      this.reason === "network_error" ||
      this.reason === "timeout" ||
      (this.reason === "http_error" &&
        this.status !== undefined &&
        (this.status === 408 || this.status === 429 || this.status >= 500))
    );
  }
}

export class VoiceprintCapabilityUnsupportedError extends Error {
  readonly capability = "identify" as const;

  constructor() {
    super(
      "Voiceprint identify is not exposed as a standalone endpoint; ASR and diarization apply saved voiceprints implicitly"
    );
    this.name = "VoiceprintCapabilityUnsupportedError";
  }
}

type Fetcher = typeof fetch;

type HttpVoiceprintProviderOptions = {
  baseUrl: string;
  fetcher?: Fetcher;
  timeoutMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  maxResponseBytes?: number;
  sleeper?: (delayMs: number) => Promise<void>;
};

const MAX_TRAINING_AUDIO_ITEMS = 2;
const MAX_TRAINING_RANGES_PER_AUDIO = 100;
const MAX_TRAINING_TIMESTAMP_MS = 86_400_000;
const MAX_IDENTIFIER_LENGTH = 512;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 1;
const MAX_MAX_RETRIES = 1;
const DEFAULT_RETRY_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;
const MIN_MAX_RESPONSE_BYTES = 1_024;
const MAX_MAX_RESPONSE_BYTES = 1024 * 1024;

function requiredIdentifier(value: string, field: string) {
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_IDENTIFIER_LENGTH) {
    throw new VoiceprintProviderError("invalid_request", `${field} is required`);
  }
  return normalized;
}

function validatedBaseUrl(value: string) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new VoiceprintProviderError("invalid_configuration", "voiceprint baseUrl must be an absolute URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new VoiceprintProviderError("invalid_configuration", "voiceprint baseUrl must use http or https");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function validatedTimeoutMs(value: number | undefined) {
  const timeoutMs = value ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
    throw new VoiceprintProviderError(
      "invalid_configuration",
      "voiceprint timeoutMs must be an integer between 1000 and 120000"
    );
  }
  return timeoutMs;
}

function validatedMaxRetries(value: number | undefined) {
  const maxRetries = value ?? DEFAULT_MAX_RETRIES;
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > MAX_MAX_RETRIES) {
    throw new VoiceprintProviderError(
      "invalid_configuration",
      `voiceprint maxRetries must be an integer between 0 and ${MAX_MAX_RETRIES}`
    );
  }
  return maxRetries;
}

function validatedRetryDelayMs(value: number | undefined) {
  const retryDelayMs = value ?? DEFAULT_RETRY_DELAY_MS;
  if (
    !Number.isInteger(retryDelayMs) ||
    retryDelayMs < 0 ||
    retryDelayMs > MAX_RETRY_DELAY_MS
  ) {
    throw new VoiceprintProviderError(
      "invalid_configuration",
      `voiceprint retryDelayMs must be an integer between 0 and ${MAX_RETRY_DELAY_MS}`
    );
  }
  return retryDelayMs;
}

function validatedMaxResponseBytes(value: number | undefined) {
  const maxResponseBytes = value ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (
    !Number.isInteger(maxResponseBytes) ||
    maxResponseBytes < MIN_MAX_RESPONSE_BYTES ||
    maxResponseBytes > MAX_MAX_RESPONSE_BYTES
  ) {
    throw new VoiceprintProviderError(
      "invalid_configuration",
      `voiceprint maxResponseBytes must be an integer between ${MIN_MAX_RESPONSE_BYTES} and ${MAX_MAX_RESPONSE_BYTES}`
    );
  }
  return maxResponseBytes;
}

function trainingAudio(input: VoiceprintTrainingAudio[]) {
  if (input.length === 0 || input.length > MAX_TRAINING_AUDIO_ITEMS) {
    throw new VoiceprintProviderError(
      "invalid_request",
      `voiceprint train audio must contain between 1 and ${MAX_TRAINING_AUDIO_ITEMS} items`
    );
  }
  return input.map((item) => {
    let url: URL;
    try {
      url = new URL(item.url);
    } catch {
      throw new VoiceprintProviderError("invalid_request", "voiceprint training audio URL must be absolute");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new VoiceprintProviderError("invalid_request", "voiceprint training audio URL must use http or https");
    }
    if (
      item.rule.length === 0 ||
      item.rule.length > MAX_TRAINING_RANGES_PER_AUDIO
    ) {
      throw new VoiceprintProviderError(
        "invalid_request",
        `voiceprint training audio requires between 1 and ${MAX_TRAINING_RANGES_PER_AUDIO} time ranges`
      );
    }
    const rule = item.rule.map(([startMilliseconds, endMilliseconds]) => {
      if (
        !Number.isFinite(startMilliseconds) ||
        !Number.isFinite(endMilliseconds) ||
        !Number.isInteger(startMilliseconds) ||
        !Number.isInteger(endMilliseconds) ||
        startMilliseconds < 0 ||
        endMilliseconds <= startMilliseconds ||
        endMilliseconds > MAX_TRAINING_TIMESTAMP_MS
      ) {
        throw new VoiceprintProviderError("invalid_request", "voiceprint training time range is invalid");
      }
      return [startMilliseconds, endMilliseconds] as [number, number];
    });
    return { url: url.toString(), rule };
  });
}

function responseRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boundedRetryAfterMs(response: Response) {
  const raw = response.headers.get("Retry-After")?.trim();
  if (!raw) return undefined;

  let delayMs: number;
  if (/^\d+$/.test(raw)) {
    delayMs = Number(raw) * 1_000;
  } else {
    const retryAt = Date.parse(raw);
    if (!Number.isFinite(retryAt)) return undefined;
    delayMs = Math.max(0, retryAt - Date.now());
  }
  if (!Number.isFinite(delayMs)) return undefined;
  return Math.min(MAX_RETRY_DELAY_MS, Math.max(0, Math.round(delayMs)));
}

function responseError(
  response: Response,
  input: {
    okReason: "invalid_response";
    okMessage: string;
    providerCode?: number;
  }
) {
  return new VoiceprintProviderError(
    response.ok ? input.okReason : "http_error",
    response.ok ? input.okMessage : "voiceprint provider request failed",
    response.status,
    input.providerCode,
    1,
    boundedRetryAfterMs(response)
  );
}

async function readBoundedResponseText(response: Response, maxResponseBytes: number) {
  const declaredLength = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
    throw responseError(response, {
      okReason: "invalid_response",
      okMessage: "voiceprint provider response exceeded the size limit"
    });
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxResponseBytes) {
      await reader.cancel().catch(() => undefined);
      throw responseError(response, {
        okReason: "invalid_response",
        okMessage: "voiceprint provider response exceeded the size limit"
      });
    }
    chunks.push(value);
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

async function parseOperationResponse(
  response: Response,
  maxResponseBytes: number
): Promise<Omit<VoiceprintOperationResult, "attemptCount">> {
  const text = await readBoundedResponseText(response, maxResponseBytes);
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw responseError(response, {
      okReason: "invalid_response",
      okMessage: "voiceprint provider returned invalid JSON"
    });
  }

  const record = responseRecord(payload);
  if (!response.ok) {
    throw responseError(response, {
      okReason: "invalid_response",
      okMessage: "voiceprint provider returned an invalid response"
    });
  }
  if (!record || record.code !== 0) {
    if (record && typeof record.code === "number") {
      throw new VoiceprintProviderError(
        "provider_rejected",
        "voiceprint provider rejected the request",
        response.status,
        record.code
      );
    }
    throw responseError(response, {
      okReason: "invalid_response",
      okMessage: "voiceprint provider response did not contain numeric code=0"
    });
  }
  if (record.message !== undefined && typeof record.message !== "string") {
    throw responseError(response, {
      okReason: "invalid_response",
      okMessage: "voiceprint provider response message must be a string"
    });
  }
  return {
    code: 0,
    ...(typeof record.message === "string" ? { message: record.message } : {})
  };
}

export class HttpVoiceprintProvider implements VoiceprintProvider {
  private readonly baseUrl: string;
  private readonly fetcher: Fetcher;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly maxResponseBytes: number;
  private readonly sleeper: (delayMs: number) => Promise<void>;

  constructor(options: HttpVoiceprintProviderOptions) {
    this.baseUrl = validatedBaseUrl(options.baseUrl);
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = validatedTimeoutMs(options.timeoutMs);
    this.maxRetries = validatedMaxRetries(options.maxRetries);
    this.retryDelayMs = validatedRetryDelayMs(options.retryDelayMs);
    this.maxResponseBytes = validatedMaxResponseBytes(options.maxResponseBytes);
    this.sleeper = options.sleeper ?? (async (delayMs) => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    });
  }

  private async attempt(path: string, body: Record<string, unknown>, attemptCount: number) {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new VoiceprintProviderError(
          "timeout",
          "voiceprint provider request timed out",
          undefined,
          undefined,
          attemptCount
        ));
      }, this.timeoutMs);
    });

    try {
      const request = (async () => {
        const response = await this.fetcher(`${this.baseUrl}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal
        });
        return await parseOperationResponse(response, this.maxResponseBytes);
      })();
      return await Promise.race([request, deadline]);
    } catch (error) {
      if (error instanceof VoiceprintProviderError) {
        throw new VoiceprintProviderError(
          error.reason,
          error.message,
          error.status,
          error.providerCode,
          attemptCount,
          error.retryAfterMs
        );
      }
      if (controller.signal.aborted) {
        throw new VoiceprintProviderError(
          "timeout",
          "voiceprint provider request timed out",
          undefined,
          undefined,
          attemptCount
        );
      }
      throw new VoiceprintProviderError(
        "network_error",
        "voiceprint provider request failed",
        undefined,
        undefined,
        attemptCount
      );
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async post(path: string, body: Record<string, unknown>) {
    const totalAttempts = this.maxRetries + 1;
    for (let attemptCount = 1; attemptCount <= totalAttempts; attemptCount += 1) {
      try {
        const result = await this.attempt(path, body, attemptCount);
        return { ...result, attemptCount };
      } catch (error) {
        if (
          !(error instanceof VoiceprintProviderError) ||
          !error.retryable ||
          attemptCount >= totalAttempts
        ) {
          throw error;
        }
        const delayMs = Math.min(
          MAX_RETRY_DELAY_MS,
          Math.max(this.retryDelayMs, error.retryAfterMs ?? 0)
        );
        await this.sleeper(delayMs);
      }
    }
    throw new VoiceprintProviderError(
      "invalid_response",
      "voiceprint provider request did not produce a result",
      undefined,
      undefined,
      totalAttempts
    );
  }

  async train(input: VoiceprintTrainInput) {
    return await this.post("/api/ai/voiceprint/train", {
      user_id: requiredIdentifier(input.userId, "userId"),
      audio: trainingAudio(input.audio),
      req_id: requiredIdentifier(input.requestId, "requestId")
    });
  }

  async save(input: VoiceprintSaveInput) {
    return await this.post("/api/ai/voiceprint/save", {
      user_id: requiredIdentifier(input.userId, "userId"),
      record_id: requiredIdentifier(input.recordId, "recordId"),
      speaker_id: requiredIdentifier(input.speakerId, "speakerId"),
      speaker_name: requiredIdentifier(input.speakerName, "speakerName"),
      req_id: requiredIdentifier(input.requestId, "requestId")
    });
  }

  async identify(_input: VoiceprintIdentifyInput): Promise<VoiceprintIdentification[]> {
    throw new VoiceprintCapabilityUnsupportedError();
  }
}

function configuredTimeoutMs() {
  const raw = process.env.VOICEPRINT_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_REQUEST_TIMEOUT_MS;
  return validatedTimeoutMs(Number(raw));
}

function configuredMaxRetries() {
  const raw = process.env.VOICEPRINT_MAX_RETRIES?.trim();
  if (!raw) return DEFAULT_MAX_RETRIES;
  return validatedMaxRetries(Number(raw));
}

function configuredRetryDelayMs() {
  const raw = process.env.VOICEPRINT_RETRY_DELAY_MS?.trim();
  if (!raw) return DEFAULT_RETRY_DELAY_MS;
  return validatedRetryDelayMs(Number(raw));
}

function configuredMaxResponseBytes() {
  const raw = process.env.VOICEPRINT_RESPONSE_MAX_BYTES?.trim();
  if (!raw) return DEFAULT_MAX_RESPONSE_BYTES;
  return validatedMaxResponseBytes(Number(raw));
}

export function createConfiguredVoiceprintProvider(options: { fetcher?: Fetcher } = {}) {
  const baseUrl =
    process.env.VOICEPRINT_BASE_URL?.trim() ||
    process.env.SPEAKER_ASR_BASE_URL?.trim();
  if (!baseUrl) {
    throw new VoiceprintProviderError(
      "invalid_configuration",
      "VOICEPRINT_BASE_URL or SPEAKER_ASR_BASE_URL is required"
    );
  }
  return new HttpVoiceprintProvider({
    baseUrl,
    timeoutMs: configuredTimeoutMs(),
    maxRetries: configuredMaxRetries(),
    retryDelayMs: configuredRetryDelayMs(),
    maxResponseBytes: configuredMaxResponseBytes(),
    ...(options.fetcher ? { fetcher: options.fetcher } : {})
  });
}

export class InMemoryVoiceprintProvider implements VoiceprintProvider {
  readonly trainCalls: VoiceprintTrainInput[] = [];
  readonly saveCalls: VoiceprintSaveInput[] = [];
  private identifications: VoiceprintIdentification[];

  constructor(identifications: VoiceprintIdentification[] = []) {
    this.identifications = identifications.map((item) => ({ ...item }));
  }

  setIdentifications(identifications: VoiceprintIdentification[]) {
    this.identifications = identifications.map((item) => ({ ...item }));
  }

  async train(input: VoiceprintTrainInput): Promise<VoiceprintOperationResult> {
    this.trainCalls.push(structuredClone(input));
    return { code: 0, message: "success", attemptCount: 1 };
  }

  async save(input: VoiceprintSaveInput): Promise<VoiceprintOperationResult> {
    this.saveCalls.push(structuredClone(input));
    return { code: 0, message: "success", attemptCount: 1 };
  }

  async identify(input: VoiceprintIdentifyInput): Promise<VoiceprintIdentification[]> {
    const requested = new Set(input.localSpeakers);
    return this.identifications
      .filter((item) => requested.has(item.localSpeaker))
      .map((item) => ({ ...item }));
  }
}
