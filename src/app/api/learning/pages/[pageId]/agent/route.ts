import { after } from "next/server";
import { z } from "zod";
import { LearningId } from "@/lib/domain/learning";
import { LearningAgentSelection, type LearningAgentScope } from "@/lib/domain/learning-agent";
import { agentModelConfig } from "@/lib/server/learning/agent-decision-config";
import { AgentFailure } from "@/lib/server/agent/types";
import { LearningError } from "@/lib/server/learning/repository";
import { freezeLearningAgentScope } from "@/lib/server/learning/agent-scope";
import { learningAgentGenerationConfig } from "@/lib/server/learning/agent-scenario";
import { LearningPlanSourceCorrections, prepareLearningPlanSourceAdjustment, materializeLearningPlanSourceAdjustment } from "@/lib/server/learning/agent-plan-sources";
import { LearningAgentRepository } from "@/lib/server/learning/agent-repository";
import { clearQuizCandidateDiagnostics } from "@/lib/server/learning/quiz-candidate-diagnostics";
import { openLearningAgentStore, projectLearningAgentTask, advanceLearningAgent, learningAgentFailure, openLearningAgentRuntime, syncLearningAgentQuiz, disputeLearningAgentQuiz, submitLearningExplanationFeedback } from "@/lib/server/learning/agent-api-service";
import { learningJson, learningJsonBody, withLearning } from "../../../route-utils";
export const runtime = "nodejs";
type Context = { params: Promise<{ pageId: string }> };
const Start = z.object({ id: LearningId, goal: z.string().trim().min(1).max(2000), scope: LearningAgentSelection }).strict();
const identity = { id: LearningId, eventId: LearningId };
const version = z.number().int().positive();
const Control = z.union([
  z.object({ ...identity, action: z.enum(["pause", "resume", "cancel", "feedback"]), expectedVersion: version.optional(),
    feedback: z.string().trim().min(1).max(2000).optional(), attemptId: LearningId.optional() }).strict(),
  z.object({ ...identity, action: z.literal("adjust"), expectedVersion: version,
    goal: z.string().trim().min(1).max(2000), scope: LearningAgentSelection, sourceCorrections: LearningPlanSourceCorrections.optional() }).strict(),
  z.object({ ...identity, action: z.literal("approval"), expectedVersion: version, approvalId: z.string().min(1).max(180),
    fingerprint: z.string().min(1).max(128), decision: z.enum(["approve", "reject"]) }).strict(),
  z.object({ ...identity, action: z.literal("recover"), expectedVersion: version, mode: z.enum(["inspect", "retry"]) }).strict(),
  z.object({ ...identity, action: z.literal("end"), expectedVersion: version }).strict(),
  z.object({ ...identity, action: z.literal("sync_quiz"), expectedVersion: version, attemptId: LearningId }).strict(),
  z.object({ ...identity, action: z.literal("dispute_quiz"), expectedVersion: version, attemptId: LearningId, feedback: z.string().trim().min(1).max(2000) }).strict(),
  z.object({ ...identity, action: z.literal("explanation_feedback"), expectedVersion: version, explanationId: LearningId,
    outcome: z.enum(["resolved", "needs_clarification"]), message: z.string().trim().min(1).max(1000).optional() }).strict()
]);
export async function GET(request: Request, context: Context) {
  return withLearning(request, async learning => {
    const pageId = LearningId.parse((await context.params).pageId); learning.get(pageId);
    const store = openLearningAgentStore(learning);
    try { return learningJson({ tasks: store.listTasks(learning.accountId, pageId).map(t => projectLearningAgentTask(learning, t, store)) }); }
    catch (error) { return learningAgentFailure(error); } finally { store.close(); }
  });
}
export async function POST(request: Request, context: Context) {
  return withLearning(request, async learning => {
    const pageId = LearningId.parse((await context.params).pageId), value = Start.parse(await learningJsonBody(request));
    const store = openLearningAgentStore(learning);
    try {
      agentModelConfig(); learningAgentGenerationConfig();
      const scope = { ...freezeLearningAgentScope(learning, pageId, value.scope), completionVersion: 1 as const };
      const task = store.createTask({ id: value.id, accountId: learning.accountId, resourceId: pageId, scenario: "learning.adaptive-review.v1", goal: value.goal, scope });
      const root = learning.accountDataRoot, accountId = learning.accountId;
      if (task.status === "ready") after(() => advanceLearningAgent(root, accountId, task.id).then(() => undefined));
      return learningJson({ task: projectLearningAgentTask(learning, task, store) }, 202);
    } catch (error) { return learningAgentFailure(error); } finally { store.close(); }
  });
}
export async function PATCH(request: Request, context: Context) {
  return withLearning(request, async learning => {
    const pageId = LearningId.parse((await context.params).pageId), value = Control.parse(await learningJsonBody(request));
    learning.get(pageId); const store = openLearningAgentStore(learning);
    try {
      let task = store.getTask(learning.accountId, value.id);
      if (task.resourceId !== pageId) throw new LearningError(404, "agent_not_found");
      const root = learning.accountDataRoot, accountId = learning.accountId;
      // A1 clients may omit the version only while the task remains at v1.
      // A stale browser cannot pause, submit feedback or approve a new goal.
      const expectedVersion = value.expectedVersion ?? 1;
      if (value.action !== "adjust" && expectedVersion !== (task.version ?? 1)) throw new AgentFailure("conflict", "agent_version_conflict");
      let scheduled = false;
      if (value.action === "sync_quiz") {
        ({ task, scheduled } = await syncLearningAgentQuiz(learning, store, task.id, value));
        if (scheduled) after(() => advanceLearningAgent(root, accountId, task.id).then(() => undefined));
      } else if (value.action === "dispute_quiz") {
        task = await disputeLearningAgentQuiz(learning, store, task.id, value);
      } else if (value.action === "explanation_feedback") {
        ({ task, scheduled } = await submitLearningExplanationFeedback(learning, store, task.id, value));
        if (scheduled) after(() => advanceLearningAgent(root, accountId, task.id).then(() => undefined));
      } else if (value.action === "feedback") {
        const previous = store.getEvent(accountId, task.id, value.eventId);
        const event = { id: value.eventId, kind: value.attemptId ? (value.feedback ? "quiz_dispute" : "quiz_submission") : "feedback",
          refId: value.attemptId ?? (previous?.kind === "feedback" ? previous.refId : task.wait?.kind === "feedback" ? task.wait.refId : undefined), message: value.feedback,
          ...(value.expectedVersion === undefined ? {} : { version: expectedVersion }) };
        // Repeated accepted events are read-only receipts, including after the
        // task reached a different wait or ended. Never trigger another decision.
        const accepted = store.acceptedEvent(accountId, task.id, event);
        if (accepted && accepted.event.message !== event.message) throw new AgentFailure("conflict", "agent_feedback_conflict");
        if (!accepted?.consumed) {
          if (task.status !== "waiting") throw new LearningError(409, "agent_feedback_not_ready");
          const runtime = openLearningAgentRuntime(learning, store);
          try { task = await runtime.submitEvent(accountId, task.id, event, { expectedVersion, defer: true }); }
          finally { runtime.close(); }
          const receipt = store.acceptedEvent(accountId, task.id, event);
          if (!receipt) throw new LearningError(409, "agent_busy");
          if (!receipt.consumed) {
            after(() => advanceLearningAgent(root, accountId, task.id).then(() => undefined)); scheduled = true;
          }
        }
      } else if (["adjust", "approval", "recover", "end"].includes(value.action)) {
        const runtime = openLearningAgentRuntime(learning, store);
        try {
          if (value.action === "adjust") {
            const scope: LearningAgentScope = { ...freezeLearningAgentScope(learning, pageId, value.scope),
              ...((task.scope as LearningAgentScope).completionVersion === 1 ? { completionVersion: 1 as const } : {}) };
            if (value.sourceCorrections) {
              const prior = (task.scope as LearningAgentScope).planSourceAdjustment;
              if ((task.version ?? 1) !== expectedVersion) {
                // Preserve the original control identity for an exact repeated
                // confirmation; AgentStore still rejects a different event/body.
                if ((task.version ?? 1) !== expectedVersion + 1 || prior?.previousVersion !== expectedVersion
                  || JSON.stringify(prior.corrections) !== JSON.stringify(value.sourceCorrections))
                  throw new AgentFailure("conflict", "agent_version_conflict");
                scope.planSourceAdjustment = prior;
              } else scope.planSourceAdjustment = prepareLearningPlanSourceAdjustment(learning, task, { goal: value.goal, scope }, value.sourceCorrections);
            }
            task = await runtime.adjust(accountId, task.id, { expectedVersion, goal: value.goal, scope, eventId: value.eventId });
            clearQuizCandidateDiagnostics(learning, pageId, { taskId: task.id, exceptVersion: task.version ?? 1 });
            new LearningAgentRepository(learning).invalidateNotePreviews(pageId, task.id, task.version ?? 1);
            // Local deterministic write only. If interrupted, the persisted
            // consent recipe is resumed by observe/tools; no paid plan retry.
            await materializeLearningPlanSourceAdjustment(learning, { task, actionId: "user-source-adjustment",
              signal: new AbortController().signal, assertActive: async () => {
                const current = store.assertVersion(accountId, task.id, task.version ?? 1);
                if (["cancelled", "ended", "paused"].includes(current.status)) throw new AgentFailure("inactive", "agent_adjustment_inactive");
              },
              call: async () => { throw new AgentFailure("forbidden", "agent_adjustment_model_forbidden"); } });
          } else if (value.action === "approval") {
            task = await runtime.resolveApproval(accountId, task.id, { expectedVersion, approvalId: value.approvalId,
              fingerprint: value.fingerprint, decision: value.decision, eventId: value.eventId, defer: true });
            if (value.decision === "reject") new LearningAgentRepository(learning).invalidateNotePreviews(pageId, task.id);
            const receipt = store.acceptedEvent(accountId, task.id, { id: value.eventId, kind: "approval", refId: value.approvalId,
              version: expectedVersion, fingerprint: value.fingerprint, decision: value.decision });
            if (!receipt) throw new LearningError(409, "agent_busy");
            scheduled = !receipt.consumed;
          } else if (value.action === "recover") {
            if (value.mode === "retry" && !task.recovery?.allowedControls.includes("retry")) throw new LearningError(409, "agent_retry_unavailable");
            task = await runtime.recover(accountId, task.id, { expectedVersion, mode: value.mode, eventId: value.eventId, defer: true });
          } else if (value.action === "end") {
            task = await runtime.end(accountId, task.id, { expectedVersion, eventId: value.eventId });
            new LearningAgentRepository(learning).invalidateNotePreviews(pageId, task.id);
          }
        } finally { runtime.close(); }
        if (scheduled || (task.status === "ready" && (value.action !== "recover" || value.mode === "retry"))) {
          after(() => advanceLearningAgent(root, accountId, task.id).then(() => undefined)); scheduled = true;
        }
      } else {
        // The version check is repeated inside the transaction by the store.
        task = store.control(accountId, task.id, value.action as "pause" | "resume" | "cancel", expectedVersion);
        if (value.action === "cancel") new LearningAgentRepository(learning).invalidateNotePreviews(pageId, task.id);
        if (value.action === "resume" && task.status === "waiting" && task.wait?.kind === "quiz_submission" && task.wait.refId) {
          ({ task, scheduled } = await syncLearningAgentQuiz(learning, store, task.id, { expectedVersion, attemptId: task.wait.refId }));
          if (scheduled) after(() => advanceLearningAgent(root, accountId, task.id).then(() => undefined));
        }
        if (value.action === "resume" && task.status === "ready") { after(() => advanceLearningAgent(root, accountId, task.id).then(() => undefined)); scheduled = true; }
      }
      return learningJson({ task: projectLearningAgentTask(learning, task, store), scheduled }, 202);
    } catch (error) { return learningAgentFailure(error); } finally { store.close(); }
  });
}
