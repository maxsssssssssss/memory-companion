import { getMemoryDatabase } from "@/lib/server/memory/db";
import { createPersonAdmissionRepository } from "./admission-repository";
import { createPersonCommitmentRepository } from "./commitments";
import { createPersonMemoryRepository } from "./memory-repository";
import { createRelationshipContextBuilder } from "./relationship-context";
import { createPersonRepository } from "./repository";
import { createPersonRelationshipRepository } from "./relationship-repository";
import { createTemporalFactRepository } from "./temporal-facts";

export {
  PersonEvidenceValidationError,
  assertValidatedPersonTranscriptEvidence,
  isValidatedPersonTranscriptEvidence,
  validatePersonTranscriptEvidence
} from "./evidence";
export * from "./admission-evidence";
export * from "./admission-repository";
export { createPersonRepository, normalizePersonName, PersonRepositoryError } from "./repository";
export * from "./commitments";
export * from "./lifecycle-recalculation";
export * from "./lifecycle-support";
export * from "./memory-repository";
export * from "./relationship-repository";
export * from "./relationship-context";
export * from "./subject-resolution";
export * from "./temporal-facts";
export * from "./types";

export function getPersonRepository() {
  return createPersonRepository(getMemoryDatabase());
}

export function getPersonAdmissionRepository() {
  return createPersonAdmissionRepository(getMemoryDatabase());
}

export function getPersonMemoryRepository() {
  return createPersonMemoryRepository(getMemoryDatabase());
}

export function getPersonRelationshipRepository() {
  return createPersonRelationshipRepository(getMemoryDatabase());
}

export function getTemporalFactRepository() {
  return createTemporalFactRepository(getMemoryDatabase());
}

export function getPersonCommitmentRepository() {
  return createPersonCommitmentRepository(getMemoryDatabase());
}

export function getRelationshipContextBuilder() {
  return createRelationshipContextBuilder(getMemoryDatabase());
}
