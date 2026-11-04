import type Database from "better-sqlite3";
import { getDailyReflectionDatabase } from "./db";
import { ThinkingAgentService } from "./thinking-agent";

const services = new WeakMap<Database.Database, ThinkingAgentService>();
export function getThinkingAgentService() {
  const database = getDailyReflectionDatabase();
  let service = services.get(database);
  if (!service) { service = new ThinkingAgentService(database); services.set(database, service); }
  return service;
}
