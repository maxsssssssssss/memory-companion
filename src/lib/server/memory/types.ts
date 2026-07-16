import { z } from "zod";
import type { TranscriptSegment } from "@/lib/domain/types";

const DateKeySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const RecordIdSchema = z.string().trim().min(1).max(512);

export const MemoryItemTypeSchema = z.enum([
  "event",
  "commitment",
  "question",
  "relationship_signal",
  "preference",
  "summary"
]);

export const MemoryEvidenceSourceTypeSchema = z.enum([
  "transcript",
  "brief",
  "timeline",
  "audio_insight",
  "relationship_signal"
]);

export const MemoryStatusSchema = z.enum(["active", "resolved", "expired", "superseded"]);

export const MemoryRelationTypeSchema = z.enum([
  "related",
  "repeated",
  "resolved_by",
  "contradicted_by",
  "follow_up"
]);

const ImportanceReasonsSchema = z.array(z.string().trim().min(1).max(200)).max(20);

export const MemoryEvidenceWriteSchema = z.object({
  id: RecordIdSchema,
  sourceType: MemoryEvidenceSourceTypeSchema,
  sourceId: RecordIdSchema,
  uploadId: RecordIdSchema,
  date: DateKeySchema,
  quote: z.string().min(1).max(4_000).refine((value) => value.trim().length > 0, {
    message: "Evidence quote cannot be blank"
  }),
  createdAt: z.string().datetime()
});

export const MemoryWriteInputSchema = z.object({
  id: RecordIdSchema,
  type: MemoryItemTypeSchema,
  title: z.string().trim().min(1).max(500),
  summary: z.string().trim().min(1).max(4_000),
  importance: z.number().min(0).max(1),
  importanceScore: z.number().min(0).max(1).optional(),
  importanceReasons: ImportanceReasonsSchema.optional(),
  status: MemoryStatusSchema.optional(),
  occurrenceCount: z.number().int().min(1).optional(),
  firstSeenDate: DateKeySchema.optional(),
  lastSeenDate: DateKeySchema.optional(),
  accessCount: z.number().int().min(0).optional(),
  lastAccessedAt: z.string().datetime().nullable().optional(),
  date: DateKeySchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  evidence: z.array(MemoryEvidenceWriteSchema).min(1)
});

export const MemoryEvidenceSchema = MemoryEvidenceWriteSchema.extend({
  memoryId: RecordIdSchema
});

export const MemoryItemSchema = MemoryWriteInputSchema.omit({ evidence: true }).extend({
  userId: RecordIdSchema,
  importanceScore: z.number().min(0).max(1),
  importanceReasons: ImportanceReasonsSchema,
  status: MemoryStatusSchema,
  occurrenceCount: z.number().int().min(1),
  firstSeenDate: DateKeySchema,
  lastSeenDate: DateKeySchema,
  accessCount: z.number().int().min(0),
  lastAccessedAt: z.string().datetime().nullable(),
  evidence: z.array(MemoryEvidenceSchema).min(1)
});

export const MemoryRelationWriteSchema = z.object({
  id: RecordIdSchema,
  sourceMemoryId: RecordIdSchema,
  targetMemoryId: RecordIdSchema,
  relationType: MemoryRelationTypeSchema,
  confidence: z.number().min(0).max(1),
  createdAt: z.string().datetime()
}).refine((value) => value.sourceMemoryId !== value.targetMemoryId, {
  message: "A memory cannot relate to itself"
});

export const MemoryRelationSchema = MemoryRelationWriteSchema;

export type MemoryItemType = z.infer<typeof MemoryItemTypeSchema>;
export type MemoryEvidenceSourceType = z.infer<typeof MemoryEvidenceSourceTypeSchema>;
export type MemoryStatus = z.infer<typeof MemoryStatusSchema>;
export type MemoryRelationType = z.infer<typeof MemoryRelationTypeSchema>;
export type MemoryEvidenceWrite = z.infer<typeof MemoryEvidenceWriteSchema>;
export type MemoryWriteInput = z.input<typeof MemoryWriteInputSchema>;
export type NormalizedMemoryWriteInput = z.output<typeof MemoryWriteInputSchema>;
export type MemoryEvidence = z.infer<typeof MemoryEvidenceSchema>;
export type MemoryItem = z.infer<typeof MemoryItemSchema>;
export type MemoryRelationWrite = z.infer<typeof MemoryRelationWriteSchema>;
export type MemoryRelation = z.infer<typeof MemoryRelationSchema>;

export type RelevantMemoryQuery = {
  userId: string;
  startDate?: string;
  endDate?: string;
  uploadId?: string;
  types?: MemoryItemType[];
  limit?: number;
};

export type ReplaceUploadMemoriesInput = {
  userId: string;
  uploadId: string;
  memories: MemoryWriteInput[];
  sourceSegments?: TranscriptSegment[];
};

export type MemoryIndexUpdateResult = {
  inputCount: number;
  memoryCount: number;
  mergedCount: number;
  relationCount: number;
};

export type RelatedMemory = {
  relation: MemoryRelation;
  memory: MemoryItem;
};

export type MemoryRepository = {
  replaceUploadMemories(input: ReplaceUploadMemoriesInput): MemoryIndexUpdateResult;
  getRelevantMemories(query: RelevantMemoryQuery): MemoryItem[];
  deleteByUpload(userId: string, uploadId: string): void;
  getImportantMemories(userId: string, limit?: number): MemoryItem[];
  getActiveCommitments(userId: string, limit?: number): MemoryItem[];
  getUnresolvedQuestions(userId: string, limit?: number): MemoryItem[];
  getRepeatedMemories(userId: string, limit?: number): MemoryItem[];
  getRelatedMemories(userId: string, memoryId: string): RelatedMemory[];
  getMemoryRelations(userId: string): MemoryRelation[];
  getUserIds(): string[];
  rebuildUserMemories(userId: string): MemoryIndexUpdateResult;
};
