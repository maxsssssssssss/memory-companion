import { getDailyReflectionDatabase } from "./db";
import { createDailyReflectionRepository } from "./repository";

export function getDailyReflectionRepository() {
  return createDailyReflectionRepository(getDailyReflectionDatabase());
}

export * from "./db";
export * from "./duration-resolver";
export * from "./candidate-builder";
export * from "./canonical-transcript";
export * from "./candidate-revocation";
export * from "./cleanup";
export * from "./job-store";
export * from "./memory-admission";
export * from "./process-upload";
export * from "./published-assets";
export * from "./repository";
export * from "./runtime-config";
export * from "./schema";
export * from "./service";
export * from "./state-machine";
export * from "./upload-record";
