import { getDailyReflectionDatabase } from "./db";
import { createDailyReflectionRepository } from "./repository";

export function getDailyReflectionRepository() {
  return createDailyReflectionRepository(getDailyReflectionDatabase());
}

export * from "./db";
export * from "./duration-resolver";
export * from "./candidate-builder";
export * from "./candidate-provider";
export * from "./card-pipeline-policy";
export * from "./canonical-transcript";
export * from "./candidate-revocation";
export * from "./cleanup";
export * from "./job-store";
export * from "./input-orchestrator";
export * from "./memory-admission";
export * from "./memory-proposal-policy";
export * from "./memory-proposal-repository";
export * from "./memory-proposal-service";
export * from "./process-upload";
export * from "./published-assets";
export * from "./repository";
export * from "./return-service";
export * from "./return-source-repository";
export * from "./return-time";
export * from "./runtime-config";
export * from "./schema";
export * from "./service";
export * from "./state-machine";
export * from "./upload-record";
export * from "./working-card-memory-revocation-repository";
export * from "./working-card-memory-revocation-service";
