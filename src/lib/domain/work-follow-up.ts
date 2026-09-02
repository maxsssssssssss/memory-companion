import { z } from "zod";

import {
  WorkReviewIdSchema,
  WorkReviewIsoDateTimeSchema,
  WorkReviewVersionSchema
} from "./work-review";

export const WORK_MEETING_FOLLOW_UP_CONTRACT_VERSION = 1 as const;

export const WorkMeetingFollowUpBodySchema = z.string().trim().min(1).max(100_000);
export const WorkMeetingFollowUpDigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);

export const WorkMeetingFollowUpCopySlicesSchema = z.object({
  full: WorkMeetingFollowUpBodySchema,
  decisions: z.string().max(100_000),
  actions: z.string().max(100_000),
  selectiveSlicesSource: z.literal("system_snapshot")
}).strict();

export const WorkMeetingFollowUpSourceStatsSchema = z.object({
  findingCount: z.number().int().nonnegative(),
  todoCount: z.number().int().nonnegative(),
  confirmedResultCount: z.number().int().nonnegative(),
  myTodoCount: z.number().int().nonnegative(),
  waitingForOtherTodoCount: z.number().int().nonnegative(),
  unresolvedQuestionCount: z.number().int().nonnegative()
}).strict();

export const WorkMeetingFollowUpDraftSchema = z.object({
  contractVersion: z.literal(WORK_MEETING_FOLLOW_UP_CONTRACT_VERSION),
  meetingId: WorkReviewIdSchema,
  accountId: WorkReviewIdSchema,
  bodyMarkdown: WorkMeetingFollowUpBodySchema,
  systemSnapshotDigest: WorkMeetingFollowUpDigestSchema,
  currentSnapshotDigest: WorkMeetingFollowUpDigestSchema,
  stale: z.boolean(),
  version: WorkReviewVersionSchema,
  generatedAt: WorkReviewIsoDateTimeSchema,
  userEditedAt: WorkReviewIsoDateTimeSchema.nullable(),
  updatedAt: WorkReviewIsoDateTimeSchema,
  copySlices: WorkMeetingFollowUpCopySlicesSchema,
  sourceStats: WorkMeetingFollowUpSourceStatsSchema
}).strict();

export const GenerateWorkMeetingFollowUpRequestSchema = z.object({
  expectedVersion: WorkReviewVersionSchema.nullable(),
  operationKey: WorkReviewIdSchema
}).strict();

export const UpdateWorkMeetingFollowUpRequestSchema = z.object({
  bodyMarkdown: WorkMeetingFollowUpBodySchema,
  expectedVersion: WorkReviewVersionSchema,
  operationKey: WorkReviewIdSchema
}).strict();

export const ResetWorkMeetingFollowUpRequestSchema = z.object({
  expectedVersion: WorkReviewVersionSchema,
  operationKey: WorkReviewIdSchema
}).strict();

export type WorkMeetingFollowUpDraft = z.infer<typeof WorkMeetingFollowUpDraftSchema>;
export type WorkMeetingFollowUpSourceStats = z.infer<
  typeof WorkMeetingFollowUpSourceStatsSchema
>;
export type GenerateWorkMeetingFollowUpRequest = z.infer<
  typeof GenerateWorkMeetingFollowUpRequestSchema
>;
export type UpdateWorkMeetingFollowUpRequest = z.infer<
  typeof UpdateWorkMeetingFollowUpRequestSchema
>;
export type ResetWorkMeetingFollowUpRequest = z.infer<
  typeof ResetWorkMeetingFollowUpRequestSchema
>;
