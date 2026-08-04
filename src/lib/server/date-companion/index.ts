import { getDateCompanionDatabase } from "./db";
import { createDateCompanionRepository } from "./repository";

export function getDateCompanionRepository() {
  return createDateCompanionRepository(getDateCompanionDatabase());
}

export * from "./db";
export * from "./repository";
export * from "./schema";
export * from "./service";
export * from "./types";
