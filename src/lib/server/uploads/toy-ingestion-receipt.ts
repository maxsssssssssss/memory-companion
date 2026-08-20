import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import Database from "better-sqlite3";

import { requestsDateCompanionAudioSnapshot } from "@/lib/domain/date-companion-upload";

export const TOY_OPERATION_KEY_FIELD = "toyOperationKey";
export const TOY_DESTINATION_FIELD = "toyDestination";
export const TOY_RELATIONSHIP_ID_FIELD = "toyRelationshipId";
export const TOY_DATE_COMPANION_DESTINATION = "date_companion";

const LEGACY_TOY_GENERATION_FIELD = "toyGeneration";
const SAFE_IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/u;

export type ToyIngestionMode = "off" | "recovery";

export type ToyIngestionRequest = {
  operationKey: string;
  destination: typeof TOY_DATE_COMPANION_DESTINATION;
  relationshipId: string;
};

export type ToyIngestionRequestInspection =
  | { kind: "absent" }
  | { kind: "invalid"; error: "invalid_toy_ingestion_metadata" }
  | { kind: "valid"; request: ToyIngestionRequest };

function requiredString(formData: Pick<FormData, "get">, field: string) {
  const value = formData.get(field);
  return typeof value === "string" ? value.trim() : "";
}

function hasToyField(formData: Pick<FormData, "get">) {
  return [
    TOY_OPERATION_KEY_FIELD,
    TOY_DESTINATION_FIELD,
    TOY_RELATIONSHIP_ID_FIELD,
    LEGACY_TOY_GENERATION_FIELD
  ].some((field) => formData.get(field) !== null);
}

export function parseToyIngestionRequest(
  formData: Pick<FormData, "get">
): ToyIngestionRequest | null {
  const inspected = inspectToyIngestionRequest(formData);
  return inspected.kind === "valid" ? inspected.request : null;
}

export function inspectToyIngestionRequest(
  formData: Pick<FormData, "get">
): ToyIngestionRequestInspection {
  if (!hasToyField(formData)) return { kind: "absent" };

  const operationKey = requiredString(formData, TOY_OPERATION_KEY_FIELD);
  const destination = requiredString(formData, TOY_DESTINATION_FIELD);
  const relationshipId = requiredString(formData, TOY_RELATIONSHIP_ID_FIELD);
  if (
    formData.get(LEGACY_TOY_GENERATION_FIELD) !== null
    || !requestsDateCompanionAudioSnapshot(formData)
    || !SAFE_IDENTIFIER.test(operationKey)
    || destination !== TOY_DATE_COMPANION_DESTINATION
    || !SAFE_IDENTIFIER.test(relationshipId)
  ) {
    return { kind: "invalid", error: "invalid_toy_ingestion_metadata" };
  }

  return {
    kind: "valid",
    request: {
      operationKey,
      destination: TOY_DATE_COMPANION_DESTINATION,
      relationshipId
    }
  };
}

export function resolveToyIngestionMode(
  value = process.env.DAILY_BRIEF_TOY_INGESTION_MODE
): ToyIngestionMode {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "off") return "off";
  if (normalized === "recovery") return "recovery";
  // `shadow` was the original name for the same minimal receipt-recovery path.
  // Keep it only as a compatibility alias; it must not introduce another mode.
  if (normalized === "shadow") return "recovery";
  throw new Error("DAILY_BRIEF_TOY_INGESTION_MODE must be off or recovery");
}

export function getToyIngestionDatabasePath(accountDataRoot: string) {
  return join(accountDataRoot, "toy-ingestion.sqlite");
}

export function openToyIngestionDatabase(input: { filePath: string }) {
  if (input.filePath !== ":memory:") mkdirSync(dirname(input.filePath), { recursive: true });
  const database = new Database(input.filePath);
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  if (input.filePath !== ":memory:") {
    database.pragma("journal_mode = WAL");
    database.pragma("synchronous = NORMAL");
  }
  return database;
}
