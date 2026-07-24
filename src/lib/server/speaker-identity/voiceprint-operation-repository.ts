import { createHash } from "node:crypto";
import { z } from "zod";

import type { JsonStore } from "@/lib/server/storage/json-store";

const COLLECTION = "speaker-identity-voiceprint-operations";
const RecordIdSchema = z.string().trim().min(1).max(512);
const operationUpdateLocks = new Map<string, Promise<unknown>>();

const VoiceprintFailureReasonSchema = z.enum([
  "invalid_configuration",
  "invalid_request",
  "network_error",
  "timeout",
  "http_error",
  "invalid_response",
  "provider_rejected",
  "persistence_error"
]);

const VoiceprintOperationMetadataSchema = z.object({
  inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
  subjectType: z.enum(["known_user", "known_contact"]),
  providerCode: z.number().int().optional(),
  providerMessagePresent: z.boolean().optional(),
  providerAttemptCount: z.number().int().min(1).max(2).optional(),
  providerSucceeded: z.boolean(),
  audioCount: z.number().int().min(1).max(2).optional(),
  incremental: z.boolean().optional(),
  globalSpeakerId: RecordIdSchema.optional(),
  failureReason: VoiceprintFailureReasonSchema.optional(),
  failurePhase: z.enum(["provider", "persistence"]).optional(),
  retryable: z.boolean().optional(),
  httpStatus: z.number().int().min(100).max(599).optional()
}).strict();

const StoredVoiceprintOperationSchema = z.object({
  version: z.literal(1),
  operationId: RecordIdSchema,
  operationType: z.enum(["train", "save"]),
  status: z.enum(["pending", "provider_succeeded", "succeeded", "failed"]),
  providerRequestId: RecordIdSchema,
  resultMetadata: VoiceprintOperationMetadataSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict();

const SaveVoiceprintOperationInputSchema = StoredVoiceprintOperationSchema.omit({
  version: true,
  operationId: true,
  createdAt: true,
  updatedAt: true
}).strict();

type VoiceprintOperationStore = Pick<JsonStore, "read" | "write" | "list">;

export type VoiceprintOperation = z.infer<typeof StoredVoiceprintOperationSchema>;
export type SaveVoiceprintOperationInput = z.input<typeof SaveVoiceprintOperationInputSchema>;

export interface VoiceprintOperationRepository {
  save(input: SaveVoiceprintOperationInput): Promise<VoiceprintOperation>;
  get(providerRequestId: string): Promise<VoiceprintOperation | null>;
  list(): Promise<VoiceprintOperation[]>;
}

function operationDocumentId(providerRequestId: string) {
  const normalized = RecordIdSchema.parse(providerRequestId);
  return `voiceprint_${createHash("sha256").update(normalized).digest("hex")}`;
}

async function serializeOperationUpdate<T>(
  operationId: string,
  update: () => Promise<T>
): Promise<T> {
  const previous = operationUpdateLocks.get(operationId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(update);
  operationUpdateLocks.set(operationId, current);
  try {
    return await current;
  } finally {
    if (operationUpdateLocks.get(operationId) === current) {
      operationUpdateLocks.delete(operationId);
    }
  }
}

export class JsonVoiceprintOperationRepository implements VoiceprintOperationRepository {
  constructor(
    private readonly store: VoiceprintOperationStore,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  async save(input: SaveVoiceprintOperationInput) {
    const parsed = SaveVoiceprintOperationInputSchema.parse(input);
    const operationId = operationDocumentId(parsed.providerRequestId);
    return await serializeOperationUpdate(operationId, async () => {
      const currentValue = await this.store.read<unknown>(COLLECTION, operationId);
      const current =
        currentValue === null ? null : StoredVoiceprintOperationSchema.parse(currentValue);
      if (current && current.operationType !== parsed.operationType) {
        throw new Error("voiceprint provider request id is already used by another operation");
      }
      if (
        current &&
        current.resultMetadata.inputDigest !== parsed.resultMetadata.inputDigest
      ) {
        throw new Error("voiceprint provider request id is already used by different input");
      }
      if (current?.status === "succeeded") {
        return current;
      }
      if (
        current?.status === "provider_succeeded" &&
        (parsed.status === "pending" || parsed.status === "failed")
      ) {
        return current;
      }

      const timestamp = this.now();
      const operation = StoredVoiceprintOperationSchema.parse({
        version: 1,
        operationId,
        ...parsed,
        createdAt: current?.createdAt ?? timestamp,
        updatedAt: timestamp
      });
      await this.store.write(COLLECTION, operationId, operation);
      return operation;
    });
  }

  async get(providerRequestId: string) {
    const value = await this.store.read<unknown>(
      COLLECTION,
      operationDocumentId(providerRequestId)
    );
    return value === null ? null : StoredVoiceprintOperationSchema.parse(value);
  }

  async list() {
    const records = await this.store.list<unknown>(COLLECTION);
    return records
      .map(({ value }) => StoredVoiceprintOperationSchema.parse(value))
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.providerRequestId.localeCompare(right.providerRequestId)
      );
  }
}
