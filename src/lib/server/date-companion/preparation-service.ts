import type Database from "better-sqlite3";
import { getDateCompanionDatabase } from "./db";
import { PreparationAgentService } from "./preparation-agent";
const services = new WeakMap<Database.Database, PreparationAgentService>();
export function getPreparationAgentService() {
  const database = getDateCompanionDatabase();
  let service = services.get(database);
  if (!service) {
    service = new PreparationAgentService(database);
    services.set(database, service);
  }
  return service;
}
