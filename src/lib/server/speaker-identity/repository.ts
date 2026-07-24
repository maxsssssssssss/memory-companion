import { createHash } from "node:crypto";
import { z } from "zod";

import type { TranscriptChunk } from "@/lib/domain/chunks";
import type { JsonStore } from "@/lib/server/storage/json-store";
import type {
  SpeakerIdentityDirectMapping,
  SpeakerIdentityType,
  VoiceprintIdentityHint
} from "./types";

const PROFILE_COLLECTION = "speaker-identity-profiles";
const MANUAL_MAPPING_COLLECTION = "speaker-identity-manual-mappings";
const RecordIdSchema = z.string().trim().min(1).max(512);
const EXACT_PROVIDER_IDENTITY_CONFIDENCE = 0.9;

const VoiceIdentityProviderReferenceSchema = z.object({
  provider: z.literal("company_voiceprint"),
  speakerLabel: RecordIdSchema,
  lastRequestId: RecordIdSchema,
  operationType: z.enum(["train", "save"])
}).strict();

const StoredSpeakerIdentityProfileSchema = z.object({
  version: z.literal(1),
  globalSpeakerId: RecordIdSchema,
  userId: RecordIdSchema.optional(),
  contactName: z.string().trim().min(1).max(120).optional(),
  displayName: z.string().trim().min(1).max(120).optional(),
  identityType: z.enum(["known_user", "known_contact", "unknown_person"]),
  status: z.enum(["active", "disabled"]).default("active"),
  providerReference: VoiceIdentityProviderReferenceSchema.optional(),
  /** Legacy provider label retained for rows written before providerReference. */
  voiceprintSpeakerId: RecordIdSchema.optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict();

const SaveSpeakerIdentityProfileInputSchema = StoredSpeakerIdentityProfileSchema.omit({
  version: true,
  createdAt: true,
  updatedAt: true
}).strict();

const StoredManualSpeakerMappingSchema = z.object({
  version: z.literal(1),
  uploadId: RecordIdSchema,
  chunkId: RecordIdSchema,
  localSpeaker: RecordIdSchema,
  globalSpeakerId: RecordIdSchema,
  source: z.literal("manual_mapping"),
  confidence: z.literal(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict();

const SaveManualSpeakerMappingInputSchema = StoredManualSpeakerMappingSchema.omit({
  version: true,
  source: true,
  confidence: true,
  createdAt: true,
  updatedAt: true
}).strict();

const ManualMappingEnvelopeSchema = z.object({
  uploadId: RecordIdSchema
}).passthrough();

export type SpeakerIdentityProfile = z.infer<typeof StoredSpeakerIdentityProfileSchema>;
export type SaveSpeakerIdentityProfileInput = z.input<typeof SaveSpeakerIdentityProfileInputSchema>;
export type ManualSpeakerIdentityMapping = z.infer<typeof StoredManualSpeakerMappingSchema>;
export type SaveManualSpeakerIdentityMappingInput = z.input<typeof SaveManualSpeakerMappingInputSchema>;

type SpeakerIdentityStore = Pick<JsonStore, "read" | "write" | "list" | "delete">;

export interface SpeakerIdentityRepository {
  saveProfile(input: SaveSpeakerIdentityProfileInput): Promise<SpeakerIdentityProfile>;
  getProfile(globalSpeakerId: string): Promise<SpeakerIdentityProfile | null>;
  listProfiles(): Promise<SpeakerIdentityProfile[]>;
  saveManualMapping(input: SaveManualSpeakerIdentityMappingInput): Promise<ManualSpeakerIdentityMapping>;
  getManualMapping(input: {
    uploadId: string;
    chunkId: string;
    localSpeaker: string;
  }): Promise<ManualSpeakerIdentityMapping | null>;
  listManualMappings(uploadId?: string): Promise<ManualSpeakerIdentityMapping[]>;
  loadDirectMappings(uploadId: string): Promise<SpeakerIdentityDirectMapping[]>;
  loadVoiceprintHints(chunks: TranscriptChunk[]): Promise<VoiceprintIdentityHint[]>;
  deleteUploadMappings(uploadId: string): Promise<number>;
}

function documentId(kind: "profile" | "mapping", parts: string[]) {
  const digest = createHash("sha256")
    .update([kind, ...parts].join("\u001f"))
    .digest("hex");
  return `${kind}_${digest}`;
}

function profileDocumentId(globalSpeakerId: string) {
  return documentId("profile", [RecordIdSchema.parse(globalSpeakerId)]);
}

function mappingDocumentId(input: { uploadId: string; chunkId: string; localSpeaker: string }) {
  const parsed = z.object({
    uploadId: RecordIdSchema,
    chunkId: RecordIdSchema,
    localSpeaker: RecordIdSchema
  }).strict().parse({
    uploadId: input.uploadId,
    chunkId: input.chunkId,
    localSpeaker: input.localSpeaker
  });
  return documentId("mapping", [parsed.uploadId, parsed.chunkId, parsed.localSpeaker]);
}

function providerSpeakerLabel(profile: SpeakerIdentityProfile) {
  return profile.providerReference?.speakerLabel ?? profile.voiceprintSpeakerId;
}

export class JsonSpeakerIdentityRepository implements SpeakerIdentityRepository {
  constructor(
    private readonly store: SpeakerIdentityStore,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  async saveProfile(input: SaveSpeakerIdentityProfileInput) {
    const parsed = SaveSpeakerIdentityProfileInputSchema.parse(input);
    const id = profileDocumentId(parsed.globalSpeakerId);
    const existing = await this.store.read<unknown>(PROFILE_COLLECTION, id);
    const current = existing === null ? null : StoredSpeakerIdentityProfileSchema.parse(existing);
    const timestamp = this.now();
    const profile = StoredSpeakerIdentityProfileSchema.parse({
      version: 1,
      ...parsed,
      createdAt: current?.createdAt ?? timestamp,
      updatedAt: timestamp
    });
    await this.store.write(PROFILE_COLLECTION, id, profile);
    return profile;
  }

  async getProfile(globalSpeakerId: string) {
    const value = await this.store.read<unknown>(PROFILE_COLLECTION, profileDocumentId(globalSpeakerId));
    return value === null ? null : StoredSpeakerIdentityProfileSchema.parse(value);
  }

  async listProfiles() {
    const records = await this.store.list<unknown>(PROFILE_COLLECTION);
    return records
      .map(({ value }) => StoredSpeakerIdentityProfileSchema.parse(value))
      .sort((left, right) => left.globalSpeakerId.localeCompare(right.globalSpeakerId, "en"));
  }

  async saveManualMapping(input: SaveManualSpeakerIdentityMappingInput) {
    const parsed = SaveManualSpeakerMappingInputSchema.parse(input);
    const profile = await this.getProfile(parsed.globalSpeakerId);
    if (!profile) {
      throw new Error(`Speaker identity profile ${parsed.globalSpeakerId} does not exist`);
    }
    const id = mappingDocumentId(parsed);
    const existing = await this.store.read<unknown>(MANUAL_MAPPING_COLLECTION, id);
    const current = existing === null ? null : StoredManualSpeakerMappingSchema.parse(existing);
    const timestamp = this.now();
    const mapping = StoredManualSpeakerMappingSchema.parse({
      version: 1,
      ...parsed,
      source: "manual_mapping",
      confidence: 1,
      createdAt: current?.createdAt ?? timestamp,
      updatedAt: timestamp
    });
    await this.store.write(MANUAL_MAPPING_COLLECTION, id, mapping);
    return mapping;
  }

  async getManualMapping(input: { uploadId: string; chunkId: string; localSpeaker: string }) {
    const value = await this.store.read<unknown>(MANUAL_MAPPING_COLLECTION, mappingDocumentId(input));
    return value === null ? null : StoredManualSpeakerMappingSchema.parse(value);
  }

  async listManualMappings(uploadId?: string) {
    const normalizedUploadId = uploadId === undefined ? undefined : RecordIdSchema.parse(uploadId);
    const records = await this.store.list<unknown>(MANUAL_MAPPING_COLLECTION);
    return records
      .flatMap(({ value }): ManualSpeakerIdentityMapping[] => {
        if (normalizedUploadId === undefined) {
          return [StoredManualSpeakerMappingSchema.parse(value)];
        }
        const envelope = ManualMappingEnvelopeSchema.safeParse(value);
        if (!envelope.success || envelope.data.uploadId !== normalizedUploadId) {
          return [];
        }
        return [StoredManualSpeakerMappingSchema.parse(value)];
      })
      .sort(
        (left, right) =>
          left.uploadId.localeCompare(right.uploadId, "en") ||
          left.chunkId.localeCompare(right.chunkId, "en") ||
          left.localSpeaker.localeCompare(right.localSpeaker, "en")
      );
  }

  async loadDirectMappings(uploadId: string): Promise<SpeakerIdentityDirectMapping[]> {
    const mappings = await this.listManualMappings(uploadId);
    return await Promise.all(mappings.map(async (mapping) => {
      const profile = await this.getProfile(mapping.globalSpeakerId);
      if (!profile) {
        throw new Error(`Speaker identity profile ${mapping.globalSpeakerId} does not exist`);
      }
      return {
        chunkId: mapping.chunkId,
        localSpeaker: mapping.localSpeaker,
        globalSpeakerId: mapping.globalSpeakerId,
        ...(profile.displayName ? { displayName: profile.displayName } : {}),
        identityType: profile.identityType as SpeakerIdentityType,
        confidence: mapping.confidence
      };
    }));
  }

  async loadVoiceprintHints(chunks: TranscriptChunk[]): Promise<VoiceprintIdentityHint[]> {
    const profiles = (await this.listProfiles())
      .filter(
        (profile) =>
          profile.status === "active" &&
          providerSpeakerLabel(profile) &&
          profile.identityType !== "unknown_person"
      );
    const profilesByProviderId = new Map<string, SpeakerIdentityProfile[]>();
    for (const profile of profiles) {
      const providerId = providerSpeakerLabel(profile)!.normalize("NFKC").trim();
      const matches = profilesByProviderId.get(providerId) ?? [];
      matches.push(profile);
      profilesByProviderId.set(providerId, matches);
    }

    return chunks.flatMap((chunk) => {
      const localSpeakers = new Set(
        chunk.segments.flatMap((segment) => segment.speaker?.trim() ? [segment.speaker.trim()] : [])
      );
      return [...localSpeakers].flatMap((localSpeaker): VoiceprintIdentityHint[] => {
        const matches = profilesByProviderId.get(localSpeaker.normalize("NFKC").trim()) ?? [];
        if (matches.length !== 1) return [];
        const [profile] = matches;
        if (profile.identityType === "unknown_person") return [];
        return [{
          chunkId: chunk.id,
          localSpeaker,
          globalSpeakerId: profile.globalSpeakerId,
          ...(profile.displayName ? { displayName: profile.displayName } : {}),
          identityType: profile.identityType,
          confidence: EXACT_PROVIDER_IDENTITY_CONFIDENCE
        }];
      });
    });
  }

  async deleteUploadMappings(uploadId: string) {
    const normalizedUploadId = RecordIdSchema.parse(uploadId);
    const records = await this.store.list<unknown>(MANUAL_MAPPING_COLLECTION);
    const matchingIds = records.flatMap(({ id, value }) => {
      const envelope = ManualMappingEnvelopeSchema.safeParse(value);
      return envelope.success && envelope.data.uploadId === normalizedUploadId ? [id] : [];
    });
    await Promise.all(matchingIds.map((id) => this.store.delete(MANUAL_MAPPING_COLLECTION, id)));
    return matchingIds.length;
  }
}
