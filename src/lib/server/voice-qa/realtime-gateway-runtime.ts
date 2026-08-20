import { dateFromKey, formatDateKey } from "@/lib/server/retrieval/memory-scope-qa";

import type { RealtimeVoiceQaEvent } from "./realtime-controller";
import {
  realtimeVoiceQaSessions,
  type RealtimeVoiceQaSessionRegistry
} from "./realtime-session-registry";
import type {
  CreateRealtimeVoiceGatewayRuntimeInput,
  RealtimeVoiceGatewayRuntime,
  RealtimeVoiceGatewayRuntimeManager
} from "./realtime-websocket-gateway";

const MAX_RUNTIME_BUFFERED_EVENTS = 256;

type RuntimeRegistry = Pick<
  RealtimeVoiceQaSessionRegistry,
  | "create"
  | "subscribe"
  | "sendAudio"
  | "startClientTurn"
  | "cancelSessionTurn"
  | "keepAlive"
  | "markBrowserPlaybackStarted"
  | "truncatePlayback"
  | "close"
>;

function parseReferenceDate(value: string | undefined) {
  if (!value) return undefined;
  const parsed = dateFromKey(value);
  return parsed && formatDateKey(parsed) === value ? parsed : undefined;
}

class RegistryRealtimeVoiceGatewayRuntime implements RealtimeVoiceGatewayRuntime {
  private readonly listeners = new Set<(event: RealtimeVoiceQaEvent) => unknown>();
  private readonly bufferedEvents: RealtimeVoiceQaEvent[] = [];
  private readonly unsubscribeRegistry: () => void;

  constructor(
    readonly sessionId: string,
    readonly userId: string,
    private readonly registry: RuntimeRegistry
  ) {
    this.unsubscribeRegistry = registry.subscribe(
      sessionId,
      userId,
      (event) => this.publish(event)
    );
  }

  subscribe(listener: (event: RealtimeVoiceQaEvent) => unknown) {
    this.listeners.add(listener);
    for (const event of this.bufferedEvents.splice(0)) this.deliver(listener, event);
    return () => this.listeners.delete(listener);
  }

  async sendAudio(chunk: Buffer) {
    await this.registry.sendAudio(this.sessionId, this.userId, chunk);
  }

  async startClientTurn() {
    await this.registry.startClientTurn(this.sessionId, this.userId);
  }

  async cancelSessionTurn(expectedTurnSequence?: number) {
    return await this.registry.cancelSessionTurn(
      this.sessionId,
      this.userId,
      expectedTurnSequence
    );
  }

  async keepAlive() {
    await this.registry.keepAlive(this.sessionId, this.userId);
  }

  async markBrowserPlaybackStarted(turnSequence: number) {
    return await this.registry.markBrowserPlaybackStarted(
      this.sessionId,
      this.userId,
      turnSequence
    );
  }

  async truncatePlayback(
    turnSequence: number,
    providerItemId: string,
    audioEndMs: number
  ) {
    return await this.registry.truncatePlayback(
      this.sessionId,
      this.userId,
      turnSequence,
      providerItemId,
      audioEndMs
    );
  }

  async close() {
    this.unsubscribeRegistry();
    this.listeners.clear();
    this.bufferedEvents.splice(0);
    await this.registry.close(this.sessionId, this.userId).catch(() => undefined);
  }

  private publish(event: RealtimeVoiceQaEvent) {
    if (this.listeners.size === 0) {
      this.bufferedEvents.push(event);
      if (this.bufferedEvents.length > MAX_RUNTIME_BUFFERED_EVENTS) {
        this.bufferedEvents.splice(
          0,
          this.bufferedEvents.length - MAX_RUNTIME_BUFFERED_EVENTS
        );
      }
      return;
    }
    for (const listener of this.listeners) this.deliver(listener, event);
  }

  private deliver(
    listener: (event: RealtimeVoiceQaEvent) => unknown,
    event: RealtimeVoiceQaEvent
  ) {
    try {
      const result = listener(event);
      if (result && typeof (result as PromiseLike<unknown>).then === "function") {
        void Promise.resolve(result).catch(() => undefined);
      }
    } catch {
      // Gateway observers cannot break the canonical Voice runtime.
    }
  }
}

export class RegistryRealtimeVoiceGatewayRuntimeManager
implements RealtimeVoiceGatewayRuntimeManager {
  private readonly runtimes = new Map<string, RegistryRealtimeVoiceGatewayRuntime>();

  constructor(
    private readonly registry: RuntimeRegistry = realtimeVoiceQaSessions,
    private readonly environment: Readonly<Record<string, string | undefined>> = process.env
  ) {}

  async create(input: CreateRealtimeVoiceGatewayRuntimeInput) {
    const referenceDate = parseReferenceDate(input.referenceDate);
    if (input.referenceDate && !referenceDate) {
      throw new Error("voice_realtime_gateway_invalid_reference_date");
    }
    const created = await this.registry.create({
      userId: input.userId,
      store: input.store,
      scope: input.scope,
      ...(input.uploadId ? { uploadId: input.uploadId } : {}),
      ...(referenceDate ? { referenceDate } : {}),
      ...(input.context ? { context: input.context } : {}),
      ...(input.conversation ? { conversation: input.conversation } : {})
    }, this.environment);
    const runtime = new RegistryRealtimeVoiceGatewayRuntime(
      created.sessionId,
      input.userId,
      this.registry
    );
    this.runtimes.set(created.sessionId, runtime);
    return runtime;
  }

  async get(sessionId: string, userId: string) {
    const runtime = this.runtimes.get(sessionId);
    return runtime?.userId === userId ? runtime : undefined;
  }

  async close(sessionId: string, userId: string) {
    const runtime = await this.get(sessionId, userId);
    if (!runtime) return;
    this.runtimes.delete(sessionId);
    await runtime.close();
  }
}
