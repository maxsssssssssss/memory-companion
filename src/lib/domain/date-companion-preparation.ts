import { z } from "zod";
const Id = z.string().min(1).max(200);
export interface PreparationSource {
  id: string;
  interactionId: string;
  recordingDate: string;
  quote: string;
  speakerRole?: "self" | "companion";
  origin: "direct_conversation" | "user_reflection";
  valid: boolean;
  href: string;
  fingerprint: string;
}
export interface PreparationReviewLink {
  id: string;
  interactionId: string;
  recordingDate: string;
  linkedAt: string;
  available: boolean;
  originalMeetingId: string;
  nextMeetingId: string;
  originalItemIds: string[];
}
export interface PreparationItem {
  meetingId?: string;
  id: string;
  text: string;
  status: "suggested" | "selected" | "removed";
  sources: PreparationSource[];
  createdAt: string;
  sourceMessageId: string;
}
export interface PreparationMessage {
  meetingId?: string;
  reviewLinkId?: string;
  id: string;
  role: "user" | "assistant";
  text: string;
  kind: "message" | "feedback" | "correction";
  createdAt: string;
  sources: PreparationSource[];
  origin: "user_reflection" | "assistant";
}
export interface PreparationEvent {
  id: string;
  kind: string;
  text: string;
  createdAt: string;
  ordinal: number;
  data: Record<string, unknown>;
}
export interface PreparationView {
  currentMeetingId?: string;
  reviewLink?: PreparationReviewLink | null;
  id: string;
  relationshipId: string;
  version: number;
  title: string;
  status: "active" | "paused";
  interactionIds: string[];
  allowRetained: boolean;
  messages: PreparationMessage[];
  items: PreparationItem[];
  events: PreparationEvent[];
  updatedAt: string;
  createdAt: string;
  generationStatus: "idle" | "running" | "failed";
  generationMessage?: string;
  intent: string;
  date: string | null;
  constraints: string[];
}
/** Choice ownership comes from saved business decisions, never from a model summary. */
export function preparationChoiceState(view: Pick<PreparationView, "id" | "currentMeetingId" | "events">, item: PreparationItem):
  "current" | "earlier" | "withdrawn" | null {
  if (item.status === "selected") return (item.meetingId ?? view.id) === (view.currentMeetingId ?? view.id) ? "current" : "earlier";
  if (item.status === "removed" && view.events.some(event =>
    event.data.itemId === item.id && (event.kind === "select" || (event.kind === "remove" && event.data.previousStatus === "selected")))) return "withdrawn";
  return null;
}

/** The independent temporary review grant never changes the user's base selection. */
export function effectivePreparationInteractionIds(view: Pick<PreparationView, "interactionIds" | "reviewLink">) {
  if (!view.reviewLink?.available || view.interactionIds.includes(view.reviewLink.interactionId)) return view.interactionIds;
  return [...view.interactionIds, view.reviewLink.interactionId];
}

export const PreparationCreateSchema = z.object({
  operationKey: z.string().trim().min(1).max(200), text: z.string().trim().min(1).max(6000),
  interactionIds: z.array(Id).max(100).default([]), allowRetained: z.boolean().default(false),
}).strict();
export const PreparationTurnSchema = z.object({
  operationKey: z.string().trim().min(1).max(200), expectedVersion: z.number().int().nonnegative(),
  text: z.string().trim().min(1).max(6000), kind: z.enum(["message", "feedback", "correction"]).default("message"),
}).strict();
export const PreparationMutationSchema = z.object({
  operationKey: z.string().trim().min(1).max(200), expectedVersion: z.number().int().nonnegative(),
  kind: z.enum(["select", "edit", "remove", "scope", "pause", "link_review", "unlink_review"]), itemId: Id.optional(), interactionId: Id.optional(),
  text: z.string().trim().min(1).max(2000).optional(), interactionIds: z.array(Id).max(100).optional(),
  allowRetained: z.boolean().optional(),
}).strict();
export const PreparationDeleteSchema = z.object({ operationKey: z.string().trim().min(1).max(200), expectedVersion: z.number().int().nonnegative() }).strict();
