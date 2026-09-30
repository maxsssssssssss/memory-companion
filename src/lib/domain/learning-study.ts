import { z } from "zod";
import { LearningId, LearningTitle } from "./learning";
import type { FrameworkSource } from "./learning-framework";

const text = z.string().trim().min(1).max(20000);
const reference = z.object({ materialId: LearningId, paragraph: z.number().int().positive() }).strict();
export const GeneratedOverview = z.object({
  summary: text,
  items: z.array(z.object({
    kind: z.enum(["prerequisite", "distinction", "complement", "connection", "conflict"]),
    title: LearningTitle, explanation: text, chapterIds: z.array(LearningId).min(2).max(30),
    sources: z.array(reference).min(1).max(100)
  }).strict()).max(200)
}).strict();
// The model selects short references supplied for this attempt, never database IDs.
// Validate items separately so an independent bad relation cannot discard valid ones.
export const ReferencedOverviewItem = GeneratedOverview.shape.items.element.omit({ chapterIds: true }).extend({
  chapterRefs: z.array(z.string().min(1).max(100)).min(2).max(30)
}).strict();
export const ReferencedOverview = z.object({
  contractVersion: z.literal("chapter-references-v1"), summary: text, items: z.array(z.unknown()).max(200)
}).strict();
export type OverviewValidation = { submitted: number; accepted: number; rejected: Array<{ index: number; reason: string }> };
export const GeneratedNodeAnswer = z.object({
  materialAnswer: text.nullable(),
  supplements: z.array(z.object({ kind: z.enum(["explanation", "example"]), text }).strict()).max(10),
  items: z.array(reference).max(100)
}).strict().refine(v => (v.materialAnswer !== null || v.supplements.length > 0) && (v.materialAnswer === null || v.items.length > 0));
export const StartOverview = z.object({ id: LearningId, resume: z.literal(true).optional() }).strict();
export const AskLearningNode = z.object({
  id: LearningId, conversationId: LearningId, chapterId: LearningId, nodeId: LearningId,
  action: z.enum(["ask", "rephrase", "example"]), question: z.string().trim().min(1).max(4000)
}).strict();
export const SaveAnswerNote = z.object({
  turnId: LearningId, chapterId: LearningId, nodeId: LearningId, revision: z.number().int().nonnegative(),
  section: z.number().int().min(-1).max(9) // -1 material answer; nonnegative supplemental paragraph
}).strict();
export type NodeAnswer = Omit<z.infer<typeof GeneratedNodeAnswer>, "items"> & { items: FrameworkSource[] };
export type OverviewResult = Omit<z.infer<typeof GeneratedOverview>, "items"> & {
  items: Array<Omit<z.infer<typeof GeneratedOverview>["items"][number], "sources"> & { sources: FrameworkSource[] }>
  validation?: OverviewValidation; generatedSummary?: string;
};
export type StudyStatus = "generating" | "completed" | "failed";
export type OverviewView = {
  latest: { id: string; status: StudyStatus; failure: string | null; validation?: OverviewValidation } | null;
  published: { id: string; result: OverviewResult; stale: boolean; sourceState: string } | null;
};
export type NodeTurn = {
  id: string; question: string; action: string; createdAt: string; status: StudyStatus; failure: string | null;
  answer: NodeAnswer | null; contextTurnIds: string[]; omittedTurns: number; savedSections: number[];
};
export type NodeConversation = { id: string; title: string; state: string; turns: NodeTurn[] };
