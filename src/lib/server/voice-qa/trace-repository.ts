import type { JsonStore } from "@/lib/server/storage/json-store";

import {
  VoiceSessionTraceSchema,
  type UpdateVoiceSessionTraceInput,
  type VoiceSessionTrace,
  mergeVoiceSessionTrace,
  updateVoiceSessionTrace
} from "./trace";

export const VOICE_SESSION_TRACE_COLLECTION = "voice-session-traces";

// Auth creates a fresh JsonStore wrapper per request. A process-wide UUID key
// therefore protects the complete read-modify-write operation across requests,
// while JsonStore continues to provide atomic file replacement for each write.
const traceUpdateQueues = new Map<string, Promise<void>>();

export class VoiceSessionTraceNotFoundError extends Error {
  constructor(readonly sessionId: string) {
    super("Voice session trace was not found");
    this.name = "VoiceSessionTraceNotFoundError";
  }
}

async function serializeTraceUpdate<T>(
  sessionId: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = traceUpdateQueues.get(sessionId) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(operation);
  const barrier = run.then(() => undefined, () => undefined);
  traceUpdateQueues.set(sessionId, barrier);
  try {
    return await run;
  } finally {
    if (traceUpdateQueues.get(sessionId) === barrier) traceUpdateQueues.delete(sessionId);
  }
}

export class JsonVoiceSessionTraceRepository {
  constructor(private readonly store: JsonStore) {}

  async write(trace: VoiceSessionTrace) {
    const validated = VoiceSessionTraceSchema.parse(trace);
    await serializeTraceUpdate(validated.sessionId, async () => {
      const current = await this.read(validated.sessionId);
      const merged = current ? mergeVoiceSessionTrace(current, validated) : validated;
      if (merged !== current) await this.persistUnlocked(merged);
    });
  }

  async read(sessionId: string) {
    const value = await this.store.read<unknown>(VOICE_SESSION_TRACE_COLLECTION, sessionId);
    if (value === null) return null;
    return VoiceSessionTraceSchema.parse(value);
  }

  async update(
    sessionId: string,
    input: UpdateVoiceSessionTraceInput,
    validate?: (current: VoiceSessionTrace) => void
  ) {
    return serializeTraceUpdate(sessionId, async () => {
      const current = await this.read(sessionId);
      if (!current) throw new VoiceSessionTraceNotFoundError(sessionId);
      validate?.(current);
      const updated = updateVoiceSessionTrace(current, input);
      const changed = updated !== current;
      if (changed) await this.persistUnlocked(updated);
      return { trace: updated, changed };
    });
  }

  private async persistUnlocked(trace: VoiceSessionTrace) {
    await this.store.write(VOICE_SESSION_TRACE_COLLECTION, trace.sessionId, trace);
  }
}
