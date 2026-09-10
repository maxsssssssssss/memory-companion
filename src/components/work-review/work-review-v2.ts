import type {
  WorkReviewApi,
  WorkReviewCapabilities,
  WorkReviewV2CoreApi
} from "@/lib/client/work-review-api";

export const DISABLED_WORK_REVIEW_CAPABILITIES: WorkReviewCapabilities = {
  projects: false,
  weekly: false,
  weeklyAi: false,
  weeklyVerifier: false,
  weeklyQa: false,
  weeklyQaVerifier: false
};

const V2_METHODS = [
  "getCapabilities",
  "listMeetingsByProject",
  "setMeetingProjects",
  "listTodosByProject",
  "setTodoProjects",
  "listProjects",
  "getProject",
  "createProject",
  "updateProject",
  "getWeeklyReview",
  "generateWeeklyReview",
  "getWeeklyReviewDetail",
  "regenerateWeeklyReview",
  "updateWeeklyItem",
  "createWeeklyUserNote",
  "deleteWeeklyUserNote",
  "resetWeeklyReview",
  "deleteWeeklyReview",
  "getWeeklyQa",
  "askWeeklyQa",
  "clearWeeklyQa",
  "getWeeklySource"
] as const;

export function asWorkReviewV2Api(api: WorkReviewApi): WorkReviewV2CoreApi | null {
  return V2_METHODS.every((method) => typeof api[method] === "function")
    ? api as WorkReviewV2CoreApi
    : null;
}

export function workReviewOperationKey(prefix: string) {
  const suffix = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${suffix}`;
}
