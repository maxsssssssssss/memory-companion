import { getMemoryDatabase } from "./db";
import { createMemoryRepository } from "./repository";

export function getMemoryRepository() {
  return createMemoryRepository(getMemoryDatabase());
}

export * from "./db";
export * from "./deduplication";
export * from "./daily-reflection-publication";
export * from "./admission";
export * from "./extractor";
export * from "./importance";
export * from "./owner-review";
export * from "./owner-attribution";
export * from "./relations";
export * from "./retention-provenance";
export * from "./repository";
export * from "./retrieval-comparison";
export * from "./reprocess-owner-review";
export * from "./shadow-retrieval";
export * from "./types";
export * from "./upload-deletion";
export * from "./upgrade";
