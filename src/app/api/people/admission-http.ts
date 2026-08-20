import { NextResponse } from "next/server";
import {
  CanonicalEvidenceReferenceError,
  PersonAdmissionError,
  type PersonEntity,
  type PersonRelationship,
  type PersonSelfBinding,
  type PersonSubjectAdmission
} from "@/lib/server/person";

export function privateNoStore(response: Response) {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export function admissionJson(body: unknown, init?: ResponseInit) {
  return privateNoStore(NextResponse.json(body, init));
}

export function personAdmissionDto(person: PersonEntity) {
  return {
    id: person.id,
    displayName: person.displayName,
    status: person.status,
    version: person.version,
    explicitlyConfirmed: person.explicitlyConfirmed,
    confirmedAt: person.confirmedAt,
    createdAt: person.createdAt,
    updatedAt: person.updatedAt
  };
}

export function relationshipAdmissionDto(relationship: PersonRelationship) {
  return {
    id: relationship.id,
    personAId: relationship.personAId,
    personBId: relationship.personBId,
    type: relationship.type,
    status: relationship.status,
    version: relationship.version,
    explicitlyConfirmed: relationship.explicitlyConfirmed,
    confirmedAt: relationship.confirmedAt,
    evidenceReferences: relationship.evidence.map((evidence) => ({
      evidenceId: evidence.id,
      uploadId: evidence.uploadId,
      sourceSegmentId: evidence.sourceSegmentId
    })),
    createdAt: relationship.createdAt,
    updatedAt: relationship.updatedAt
  };
}

export function selfBindingDto(binding: PersonSelfBinding | null) {
  return binding ? {
    personId: binding.personId,
    status: binding.status,
    version: binding.version,
    setAt: binding.setAt,
    clearedAt: binding.clearedAt,
    updatedAt: binding.updatedAt
  } : null;
}

export function subjectAdmissionDto(admission: PersonSubjectAdmission) {
  return {
    id: admission.id,
    evidenceId: admission.evidenceId,
    personId: admission.personId,
    disposition: admission.disposition,
    version: admission.version,
    createdAt: admission.createdAt,
    updatedAt: admission.updatedAt
  };
}

export function admissionErrorResponse(error: unknown, notFoundError: string) {
  if (error instanceof CanonicalEvidenceReferenceError) {
    return error.code === "evidence_not_found"
      ? admissionJson({ error: "evidence_not_found" }, { status: 404 })
      : admissionJson({ error: error.code }, { status: 400 });
  }
  if (error instanceof PersonAdmissionError) {
    if (error.code === "not_found") {
      return admissionJson({ error: notFoundError }, { status: 404 });
    }
    if (error.code === "version_conflict") {
      return admissionJson({
        error: "version_conflict",
        currentVersion: error.currentVersion
      }, { status: 409 });
    }
    if (["conflict", "invalid_state", "insufficient_evidence"].includes(error.code)) {
      return admissionJson({ error: error.code }, { status: 409 });
    }
    return admissionJson({ error: "invalid_request" }, { status: 400 });
  }
  return null;
}
