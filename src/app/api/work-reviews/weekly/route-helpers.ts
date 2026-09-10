import { WorkWeeklyScopeRequestSchema } from "@/lib/domain/work-weekly";

export function parseWeeklyScopeQuery(request: Request) {
  const search = new URL(request.url).searchParams;
  const allowed = new Set(["weekStart", "timeZone", "scopeKind", "projectId"]);
  for (const key of search.keys()) {
    if (!allowed.has(key) || search.getAll(key).length !== 1) {
      throw new SyntaxError("invalid_query_parameter");
    }
  }
  return WorkWeeklyScopeRequestSchema.parse({
    weekStart: search.get("weekStart"),
    timeZone: search.get("timeZone"),
    scopeKind: search.get("scopeKind") ?? "all",
    projectId: search.get("projectId")
  });
}
