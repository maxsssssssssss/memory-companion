import { getDateCompanionDatabase } from "./db";
import { createDateCompanionRepository } from "./repository";

export function getDateCompanionRepository() {
  return createDateCompanionRepository(getDateCompanionDatabase());
}

export * from "./db";
export * from "./errors";
export * from "./memory-bridge-digest";
export * from "./memory-bridge-repository";
export * from "./memory-bridge-consumer";
export * from "./memory-bridge-purge";
export * from "./person-source-catalog";
export * from "./proactive-value";
export * from "./proactive-value-context";
export * from "./repository";
export * from "./schema";
export * from "./service";
export * from "./subject-suggestion-provider";
export * from "./subject-suggestions";
export * from "./types";
