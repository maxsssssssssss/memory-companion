import { z } from "zod";
import type { AgentTask } from "./agent";
import type { WorkTodo } from "./work-todo";
import { WorkReviewIdSchema, WorkReviewDateSchema } from "./work-review";

export const WORK_AGENT_SCENARIO = "work.project-follow-up.v1";
const id = WorkReviewIdSchema;
// Twenty selected keys must fit the shared Runtime's 2,000-character business event.
export const WorkAgentChangeKey = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u);
const base = {
  key: WorkAgentChangeKey,
  label: z.string().trim().min(1).max(400),
  sourceFindingIds: z.array(id).min(1).max(8),
};
export const WorkAgentChange = z.discriminatedUnion("kind", [
  z.object({ ...base, kind: z.literal("relation"),
    relation: z.enum(["records", "suspends", "supersedes", "withdraws", "resolves", "reopens", "tracks"]),
    anchorFindingId: id, findingId: id, todoId: id.nullable(),
  }).strict(),
  z.object({ ...base, kind: z.literal("create_todo"), findingId: id,
    title: z.string().trim().min(1).max(240), todoKind: z.enum(["self", "waiting_for_other"]),
    ownerLabel: z.string().trim().min(1).max(512).nullable(), dueDate: WorkReviewDateSchema.nullable(),
  }).strict(),
  z.object({ ...base, kind: z.literal("update_todo"), todoId: id,
    title: z.string().trim().min(1).max(240), ownerLabel: z.string().trim().min(1).max(512).nullable(),
    dueDate: WorkReviewDateSchema.nullable(),
  }).strict(),
  z.object({ ...base, kind: z.literal("complete_todo"), todoId: id }).strict(),
]);
export type WorkAgentChange = z.infer<typeof WorkAgentChange>;
export const WorkAgentComparison = z.object({
  items: z.array(z.object({ category: z.enum(["added", "changed", "resolved", "unresolved", "uncertain"]),
    text: z.string().trim().min(1).max(1200), sourceFindingIds: z.array(id).min(1).max(8),
    status: z.enum(["confirmed_fact", "suggestion", "uncertain"]),
  }).strict()).min(1).max(30),
  changes: z.array(WorkAgentChange).max(20),
}).strict();
export type WorkAgentComparison = z.infer<typeof WorkAgentComparison>;
export interface WorkAgentSource {
  findingId: string; meetingId: string; meetingTitle: string; meetingDate: string;
  version: number; fingerprint: string; kind: string; title: string; body: string;
  finality: string | null; actionBasis: string | null;
  evidence: Array<{ publicationId: string; segmentId: string; text: string; startSeconds: number; endSeconds: number; timestampQuality: string }>;
}
export interface WorkAgentCoverage {
  meetingsRead: number; meetingsAvailable: number; findingsRead: number; findingsAvailable: number;
  todosRead: number; todosAvailable: number; limited: boolean; notice: string;
}
export interface WorkAgentScope { projectId: string; meetingId: string; fingerprint: string; fromTaskId?: string }
export interface WorkAgentChangeReview {
  status: "confirmable" | "blocked" | "needs_review";
  reason: string;
  sourceFindingIds: string[];
}
export interface WorkAgentPreview {
  id: string; fingerprint: string; sourceFingerprint: string;
  changes: Array<{ change: WorkAgentChange; before: string; after: string; review?: WorkAgentChangeReview }>;
  selectedKeys: string[] | null;
}
export interface WorkAgentArtifact {
  id: string; taskId: string; taskVersion: number; meetingId: string;
  state: "compared" | "preview" | "applied" | "invalidated";
  comparison: WorkAgentComparison | null; coverage: WorkAgentCoverage | null;
  sources: WorkAgentSource[]; preview: WorkAgentPreview | null;
  applied: { selectedKeys: string[]; rejectedKeys: string[]; eventIds: string[]; todoIds: string[]; confirmedAt: string } | null;
  createdAt: string;
}
export interface WorkThreadView {
  id: string; anchorFindingId: string; title: string; state: "open" | "active" | "suspended" | "withdrawn" | "resolved" | "unknown";
  currentFindingId: string | null;
  kind: "decision" | "question" | "work" | "other";
  linkedTodos: Array<{id:string;title:string;status:WorkTodo["status"]}>;
  events: Array<{ id: string; relation: string; label: string; valid: boolean; retracted: boolean; findingId: string | null;
    todoId: string | null; retractsId: string | null; meetingDate: string; sources: WorkAgentSource[]; confirmedAt: string }>;
}
export type WorkAgentSourceLink = Pick<WorkAgentSource,"findingId"|"meetingId"|"meetingTitle"|"meetingDate">;
export interface WorkAgentTimelineItem {
  id: string; threadId?: string; eventId?: string; date: string; title: string; text: string;
  status: "fact" | "candidate" | "confirmed_relation" | "source_invalid" | "retracted";
  label: string; sources: WorkAgentSourceLink[]; canRetract: boolean;
}
export interface WorkAgentOpenLoop {
  id: string; kind: "todo" | "question" | "uncertain"; title: string; text: string;
  status: "open" | "waiting" | "unresolved" | "no_follow_up" | "needs_review" | "source_invalid" | "suggestion";
  basis: "record" | "confirmed_relation" | "needs_verification" | "agent_suggestion";
  reasons: string[]; sources: WorkAgentSourceLink[];
  linkedTodos: WorkThreadView["linkedTodos"];
  waitingForOther?: boolean;
  todoId?: string; threadId?: string; taskId?: string;
}
export interface WorkAgentTaskView {
  task: Pick<AgentTask, "id" | "version" | "goal" | "status" | "usage" | "budget" | "wait" | "endReason" | "recovery" | "approval">;
  artifact: WorkAgentArtifact | null;
}
export interface WorkAgentProjectView {
  project: { id: string; name: string }; tasks: WorkAgentTaskView[];
  threads: WorkThreadView[];
  timeline: WorkAgentTimelineItem[];
  openLoops: WorkAgentOpenLoop[];
}
export type WorkAgentTodo = Pick<WorkTodo,"id"|"title"|"status"|"kind"|"version"|"ownerLabel"|"currentDueDate"|"sourceFindingId"|"sourceMeetingId"|"origin">;
export type WorkAgentContext = {
  project: { id: string; name: string }; meetingId: string; fingerprint: string;
  sources: WorkAgentSource[]; todos: WorkAgentTodo[]; threads: WorkThreadView[]; coverage: WorkAgentCoverage;
};
