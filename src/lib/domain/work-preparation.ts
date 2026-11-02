import { z } from "zod";
import type { AgentTask } from "./agent";
import type { WorkAgentContext, WorkAgentSource, WorkAgentTimelineItem, WorkAgentOpenLoop } from "./work-agent";
import { WorkReviewIdSchema } from "./work-review";

export const WORK_PREPARATION_SCENARIO = "work.project-meeting-preparation.v1";
const id = WorkReviewIdSchema;
export const WorkAgendaItem = z.object({
  id, title: z.string().trim().min(1).max(240), reason: z.string().trim().max(1000),
  background: z.string().trim().max(6000), currentStatus: z.string().trim().max(6000),
  question: z.string().trim().min(1).max(1000), expectedOutcome: z.string().trim().max(1000),
  ownerLabel: z.string().trim().max(160).nullable(), priority: z.enum(["high", "normal", "low"]),
  sourceFindingIds: z.array(id).max(8), todoIds: z.array(id).max(6), threadIds: z.array(id).max(6),
}).strict();
export type WorkAgendaItem = z.infer<typeof WorkAgendaItem>;
export const WorkPreparationDraft = z.object({ agenda: z.array(WorkAgendaItem).max(20) }).strict();
export type WorkPreparationDraft = z.infer<typeof WorkPreparationDraft>;
// Models organize discussion; project status/background are owned by the repository.
export const WorkAgendaSuggestion = WorkAgendaItem.omit({reason:true,background:true,currentStatus:true});
export const WorkPreparationSuggestions = z.object({agenda:z.array(WorkAgendaSuggestion).max(20)}).strict();
export type WorkAgendaSuggestion = z.infer<typeof WorkAgendaSuggestion>;
// Accept the previous response contract for replay/recovery, discarding its factual prose.
export const WorkPreparationGeneration = z.union([WorkPreparationSuggestions,WorkPreparationDraft])
  .transform(draft=>({agenda:draft.agenda.map(item=>WorkAgendaSuggestion.parse({
    id:item.id,title:item.title,question:item.question,expectedOutcome:item.expectedOutcome,ownerLabel:item.ownerLabel,
    priority:item.priority,sourceFindingIds:item.sourceFindingIds,todoIds:item.todoIds,threadIds:item.threadIds,
  }))}));
export const WorkPreparationReview = z.object({
  items: z.array(z.object({ agendaId: id, status: z.enum(["completed", "decided", "unresolved", "changed", "not_discussed", "insufficient"]),
    text: z.string().trim().min(1).max(1200), sourceFindingIds: z.array(id).max(8) }).strict()).max(20),
  addedFindingIds: z.array(id).max(20),
}).strict();
export type WorkPreparationReview = z.infer<typeof WorkPreparationReview>;
export type WorkPreparationContext = Omit<WorkAgentContext, "meetingId"> & {
  meetingId: string | null;
  asOf: string;
  meetingDate: string | null;
  currentDecisions: Array<{ threadId: string; findingId: string; title: string; body: string }>;
  recentChanges: WorkAgentTimelineItem[];
  openLoops: WorkAgentOpenLoop[];
};
export type WorkPreparationBinding = { findingId: string; meetingId: string; fingerprint: string };
export interface WorkPreparation {
  id: string; projectId: string; taskId: string; goal: string; version: number;
  status: "draft" | "saved" | "linked" | "awaiting_review" | "reviewed";
  createdAt: string; updatedAt: string; meetingId: string | null; meetingTitle: string | null;
  statusAsOf: string; meetingDate: string | null;
  meetingAvailable: boolean; stale: boolean; sourceInvalid: boolean;
  agenda: Array<WorkAgendaItem & { userEdited: boolean; sourceInvalid: boolean }>;
  snapshot: Pick<WorkPreparationContext, "currentDecisions" | "recentChanges" | "openLoops" | "todos" | "coverage"> | null;
  sources: WorkAgentSource[];
  review: (WorkPreparationReview & { taskId: string; fingerprint: string; confirmed: boolean; stale: boolean; coverage: string }) | null;
  followUpTaskId: string | null;
}
export interface WorkPreparationTask {
  id: string; preparationId: string; mode: "prepare" | "review"; status: AgentTask["status"];
  version: number; message: string | null; recovery?: AgentTask["recovery"];
}
export interface WorkPreparationProject {
  preparations: WorkPreparation[]; tasks: WorkPreparationTask[];
  meetings: Array<{ id: string; title: string; meetingDate: string; reviewed: boolean }>;
}
