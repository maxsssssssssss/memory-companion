import { getMemoryDatabase } from "./db";
import { createMemoryRepository } from "./repository";

export function getMemoryRepository() {
  return createMemoryRepository(getMemoryDatabase());
}

export * from "./db";
export * from "./deduplication";
export * from "./extractor";
export * from "./importance";
export * from "./relations";
export * from "./repository";
export * from "./retrieval-comparison";
export * from "./shadow-retrieval";
export * from "./types";
export * from "./upgrade";
