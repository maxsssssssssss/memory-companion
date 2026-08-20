import { z } from "zod";

const RecordIdSchema = z.string().trim().min(1).max(512);
const NonBlankTextSchema = z.string().trim().min(1).max(500);

export const PersonStatusSchema = z.enum(["candidate", "confirmed", "archived"]);
export const PersonSourceSchema = z.enum([
  "transcript_candidate",
  "identity_profile",
  "date_companion_review",
  "manual_confirmation"
]);
export const PersonNameKindSchema = z.enum(["display_name", "alias"]);
export const PersonAssertionStatusSchema = z.enum(["candidate", "confirmed", "rejected"]);
export const PersonIdentityLinkSourceSchema = z.enum(["identity_profile", "manual_confirmation"]);
export const PersonSubjectStatusSchema = z.enum(["candidate", "confirmed", "unknown", "rejected"]);
export const PersonSubjectSourceSchema = z.enum(["manual_review", "confirmed_identity", "unknown"]);
export const PersonRelationshipStatusSchema = z.enum([
  "candidate",
  "confirmed",
  "conflict",
  "archived"
]);
export const PersonSubjectAdmissionDispositionSchema = z.enum([
  "candidate",
  "confirmed",
  "rejected",
  "unknown"
]);
export const PersonSelfBindingStatusSchema = z.enum(["active", "cleared"]);
export const PersonRelationshipTypeSchema = z.string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_-]*$/u);
export const PersonFactStatusSchema = z.enum(["active", "resolved", "superseded"]);
export const PersonFactKindSchema = z.string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_-]*$/u);
export const PersonFactKeySchema = z.string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9_.:-]*$/u);
export const PersonCommitmentStatusSchema = z.enum([
  "created",
  "active",
  "completed",
  "cancelled",
  "superseded"
]);
export const SubjectResolutionDecisionSchema = z.enum([
  "confirmed",
  "candidate",
  "unknown",
  "ambiguous",
  "failed"
]);
export const SubjectResolutionReasonCodeSchema = z.enum([
  "confirmed_first_person",
  "missing_speaker",
  "chunk_local_speaker",
  "untrusted_identity",
  "identity_link_missing",
  "identity_link_not_confirmed",
  "person_not_confirmed",
  "identity_person_conflict",
  "existing_subject_conflict",
  "not_explicit_first_person",
  "not_simple_first_person",
  "third_person_statement",
  "reported_speech",
  "quoted_speech",
  "multiple_people",
  "evidence_validation_failed",
  "resolver_failed"
]);

export const PersonEvidenceSchema = z.object({
  id: RecordIdSchema,
  accountId: RecordIdSchema,
  uploadId: RecordIdSchema,
  sourceSegmentId: RecordIdSchema,
  quote: z.string().trim().min(1).max(4_000),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

export const PersonNameSchema = z.object({
  id: RecordIdSchema,
  accountId: RecordIdSchema,
  personId: RecordIdSchema,
  evidenceId: RecordIdSchema,
  name: NonBlankTextSchema,
  normalizedName: NonBlankTextSchema,
  kind: PersonNameKindSchema,
  status: PersonAssertionStatusSchema,
  source: PersonSourceSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

export const PersonIdentityLinkSchema = z.object({
  id: RecordIdSchema,
  accountId: RecordIdSchema,
  personId: RecordIdSchema,
  identityId: RecordIdSchema,
  evidenceId: RecordIdSchema,
  status: PersonAssertionStatusSchema,
  source: PersonIdentityLinkSourceSchema,
  confirmedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

export const PersonSubjectObservationSchema = z.object({
  id: RecordIdSchema,
  accountId: RecordIdSchema,
  personId: RecordIdSchema.nullable(),
  evidenceId: RecordIdSchema,
  status: PersonSubjectStatusSchema,
  source: PersonSubjectSourceSchema,
  reason: z.string().trim().min(1).max(1_000),
  confirmedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

export const PersonEntitySchema = z.object({
  id: RecordIdSchema,
  accountId: RecordIdSchema,
  displayName: NonBlankTextSchema.nullable(),
  aliases: z.array(PersonNameSchema),
  source: PersonSourceSchema,
  status: PersonStatusSchema,
  version: z.number().int().min(1),
  explicitlyConfirmed: z.boolean(),
  confirmedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

export const PersonRelationshipSchema = z.object({
  id: RecordIdSchema,
  accountId: RecordIdSchema,
  personAId: RecordIdSchema,
  personBId: RecordIdSchema,
  type: PersonRelationshipTypeSchema,
  status: PersonRelationshipStatusSchema,
  version: z.number().int().min(1),
  explicitlyConfirmed: z.boolean(),
  confirmedAt: z.string().datetime().nullable(),
  evidence: z.array(PersonEvidenceSchema),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).superRefine((value, context) => {
  if (value.personAId === value.personBId) {
    context.addIssue({ code: "custom", message: "Relationship endpoints must be different" });
  }
  if (
    value.status === "confirmed" &&
    (!value.explicitlyConfirmed || !value.confirmedAt || value.evidence.length === 0)
  ) {
    context.addIssue({
      code: "custom",
      message: "Confirmed Relationship requires explicit confirmation and Evidence"
    });
  }
});

export const PersonSubjectAdmissionSchema = z.object({
  id: RecordIdSchema,
  accountId: RecordIdSchema,
  evidenceId: RecordIdSchema,
  personId: RecordIdSchema.nullable(),
  subjectKey: RecordIdSchema,
  observationId: RecordIdSchema,
  disposition: PersonSubjectAdmissionDispositionSchema,
  version: z.number().int().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).superRefine((value, context) => {
  if (
    (value.disposition === "unknown" && (value.personId !== null || value.subjectKey !== "unknown")) ||
    (value.disposition !== "unknown" && (
      value.personId === null || value.subjectKey !== value.personId
    ))
  ) {
    context.addIssue({ code: "custom", message: "Subject admission key does not match disposition" });
  }
});

export const PersonSelfBindingSchema = z.object({
  accountId: RecordIdSchema,
  personId: RecordIdSchema.nullable(),
  status: PersonSelfBindingStatusSchema,
  version: z.number().int().min(1),
  setAt: z.string().datetime().nullable(),
  clearedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).superRefine((value, context) => {
  const active = value.status === "active";
  if (
    active !== Boolean(value.personId) ||
    active !== Boolean(value.setAt) ||
    active === Boolean(value.clearedAt)
  ) {
    context.addIssue({ code: "custom", message: "Self binding state is inconsistent" });
  }
});

export const PersonFactTransitionSchema = z.object({
  id: RecordIdSchema,
  accountId: RecordIdSchema,
  factId: RecordIdSchema,
  fromStatus: z.literal("active"),
  toStatus: z.enum(["resolved", "superseded"]),
  observedAt: z.string().datetime(),
  occurredAt: z.string().datetime(),
  validTo: z.string().datetime().nullable(),
  replacementFactId: RecordIdSchema.nullable(),
  evidence: PersonEvidenceSchema,
  expectedVersion: z.number().int().min(1),
  resultingVersion: z.number().int().min(2),
  applied: z.boolean(),
  invalidReason: z.string().trim().min(1).max(500).nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).superRefine((value, context) => {
  if (value.resultingVersion !== value.expectedVersion + 1) {
    context.addIssue({ code: "custom", message: "Fact transition version must advance by one" });
  }
  if ((value.toStatus === "superseded") !== Boolean(value.replacementFactId)) {
    context.addIssue({ code: "custom", message: "Fact replacement must match superseded status" });
  }
  if (value.applied === Boolean(value.invalidReason)) {
    context.addIssue({ code: "custom", message: "Applied Fact transition cannot be invalid" });
  }
});

export const PersonFactSchema = z.object({
  id: RecordIdSchema,
  accountId: RecordIdSchema,
  subjectPersonId: RecordIdSchema,
  relationshipId: RecordIdSchema.nullable(),
  kind: PersonFactKindSchema,
  factKey: PersonFactKeySchema,
  derivedText: z.string().trim().min(1).max(4_000),
  observedAt: z.string().datetime(),
  validFrom: z.string().datetime().nullable(),
  validTo: z.string().datetime().nullable(),
  status: PersonFactStatusSchema,
  supersededBy: RecordIdSchema.nullable(),
  version: z.number().int().min(1),
  evidence: z.array(PersonEvidenceSchema).min(1),
  transitions: z.array(PersonFactTransitionSchema),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

export const PersonCommitmentTransitionSchema = z.object({
  id: RecordIdSchema,
  accountId: RecordIdSchema,
  commitmentId: RecordIdSchema,
  fromStatus: z.enum(["created", "active"]),
  toStatus: z.enum(["active", "completed", "cancelled", "superseded"]),
  observedAt: z.string().datetime(),
  occurredAt: z.string().datetime(),
  replacementCommitmentId: RecordIdSchema.nullable(),
  evidence: PersonEvidenceSchema,
  expectedVersion: z.number().int().min(1),
  resultingVersion: z.number().int().min(2),
  applied: z.boolean(),
  invalidReason: z.string().trim().min(1).max(500).nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).superRefine((value, context) => {
  if (value.resultingVersion !== value.expectedVersion + 1) {
    context.addIssue({ code: "custom", message: "Commitment transition version must advance by one" });
  }
  if ((value.toStatus === "superseded") !== Boolean(value.replacementCommitmentId)) {
    context.addIssue({ code: "custom", message: "Commitment replacement must match superseded status" });
  }
  if (value.applied === Boolean(value.invalidReason)) {
    context.addIssue({ code: "custom", message: "Applied Commitment transition cannot be invalid" });
  }
});

export const PersonCommitmentSchema = z.object({
  id: RecordIdSchema,
  accountId: RecordIdSchema,
  relationshipId: RecordIdSchema.nullable(),
  promisorPersonId: RecordIdSchema,
  promiseePersonId: RecordIdSchema,
  text: z.string().trim().min(1).max(4_000),
  status: PersonCommitmentStatusSchema,
  observedAt: z.string().datetime(),
  occurredAt: z.string().datetime(),
  resolvedAt: z.string().datetime().nullable(),
  supersededBy: RecordIdSchema.nullable(),
  version: z.number().int().min(1),
  evidence: z.array(PersonEvidenceSchema).min(1),
  transitions: z.array(PersonCommitmentTransitionSchema),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).superRefine((value, context) => {
  if (value.promisorPersonId === value.promiseePersonId) {
    context.addIssue({ code: "custom", message: "Commitment roles must be different Persons" });
  }
  const terminal = ["completed", "cancelled", "superseded"].includes(value.status);
  if (terminal !== Boolean(value.resolvedAt)) {
    context.addIssue({ code: "custom", message: "Commitment resolution time must match status" });
  }
  if ((value.status === "superseded") !== Boolean(value.supersededBy)) {
    context.addIssue({ code: "custom", message: "Commitment replacement must match status" });
  }
});

export const SubjectResolutionAuditSchema = z.object({
  id: RecordIdSchema,
  accountId: RecordIdSchema,
  uploadId: RecordIdSchema,
  sourceSegmentId: RecordIdSchema,
  evidenceId: RecordIdSchema.nullable(),
  decision: SubjectResolutionDecisionSchema,
  personId: RecordIdSchema.nullable(),
  identityId: RecordIdSchema.nullable(),
  subjectObservationId: RecordIdSchema.nullable(),
  subjectObservationCreated: z.boolean(),
  candidatePersonIds: z.array(RecordIdSchema),
  reasonCodes: z.array(SubjectResolutionReasonCodeSchema).min(1),
  resolverVersion: z.literal(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

export type PersonStatus = z.infer<typeof PersonStatusSchema>;
export type PersonSource = z.infer<typeof PersonSourceSchema>;
export type PersonNameKind = z.infer<typeof PersonNameKindSchema>;
export type PersonAssertionStatus = z.infer<typeof PersonAssertionStatusSchema>;
export type PersonIdentityLinkSource = z.infer<typeof PersonIdentityLinkSourceSchema>;
export type PersonSubjectStatus = z.infer<typeof PersonSubjectStatusSchema>;
export type PersonSubjectSource = z.infer<typeof PersonSubjectSourceSchema>;
export type PersonRelationshipStatus = z.infer<typeof PersonRelationshipStatusSchema>;
export type PersonRelationshipType = z.infer<typeof PersonRelationshipTypeSchema>;
export type PersonSubjectAdmissionDisposition = z.infer<
  typeof PersonSubjectAdmissionDispositionSchema
>;
export type PersonSelfBindingStatus = z.infer<typeof PersonSelfBindingStatusSchema>;
export type PersonFactStatus = z.infer<typeof PersonFactStatusSchema>;
export type PersonFactKind = z.infer<typeof PersonFactKindSchema>;
export type PersonCommitmentStatus = z.infer<typeof PersonCommitmentStatusSchema>;
export type SubjectResolutionDecision = z.infer<typeof SubjectResolutionDecisionSchema>;
export type SubjectResolutionReasonCode = z.infer<typeof SubjectResolutionReasonCodeSchema>;
export type PersonEvidence = z.infer<typeof PersonEvidenceSchema>;
export type PersonName = z.infer<typeof PersonNameSchema>;
export type PersonIdentityLink = z.infer<typeof PersonIdentityLinkSchema>;
export type PersonSubjectObservation = z.infer<typeof PersonSubjectObservationSchema>;
export type PersonEntity = z.infer<typeof PersonEntitySchema>;
export type PersonRelationship = z.infer<typeof PersonRelationshipSchema>;
export type PersonSubjectAdmission = z.infer<typeof PersonSubjectAdmissionSchema>;
export type PersonSelfBinding = z.infer<typeof PersonSelfBindingSchema>;
export type PersonFactTransition = z.infer<typeof PersonFactTransitionSchema>;
export type PersonFact = z.infer<typeof PersonFactSchema>;
export type PersonCommitmentTransition = z.infer<typeof PersonCommitmentTransitionSchema>;
export type PersonCommitment = z.infer<typeof PersonCommitmentSchema>;
export type SubjectResolutionAudit = z.infer<typeof SubjectResolutionAuditSchema>;

export type PersonUploadDeleteResult = {
  deletedEvidenceCount: number;
  deletedNameCount: number;
  deletedIdentityLinkCount: number;
  deletedSubjectObservationCount: number;
  deletedSubjectResolutionAuditCount: number;
  deletedRelationshipEvidenceCount: number;
  archivedRelationshipCount: number;
  deletedFactEvidenceCount: number;
  deletedFactTransitionCount: number;
  deletedFactCount: number;
  recalculatedFactCount: number;
  deletedCommitmentEvidenceCount: number;
  deletedCommitmentTransitionCount: number;
  deletedCommitmentCount: number;
  recalculatedCommitmentCount: number;
  archivedPersonCount: number;
};
