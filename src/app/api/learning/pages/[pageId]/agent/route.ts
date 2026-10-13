import { after } from "next/server";
import { z } from "zod";
import { LearningId } from "@/lib/domain/learning";
import { LearningAgentSelection } from "@/lib/domain/learning-agent";
import { agentModelConfig } from "@/lib/server/learning/agent-decision-config";
import { AgentFailure } from "@/lib/server/agent/types";
import { LearningError } from "@/lib/server/learning/repository";
import { freezeLearningAgentScope } from "@/lib/server/learning/agent-scope";
import { createLearningAgentScenario, learningAgentGenerationConfig } from "@/lib/server/learning/agent-scenario";
import { openLearningAgentStore, projectLearningAgentTask, advanceLearningAgent, learningAgentFailure } from "@/lib/server/learning/agent-api-service";
import { learningJson, learningJsonBody, withLearning } from "../../../route-utils";
import type { AgentContext } from "@/lib/server/agent/types";
export const runtime = "nodejs";
type Context = { params: Promise<{ pageId: string }> };
const Start = z.object({ id: LearningId, goal: z.string().trim().min(1).max(2000), scope: LearningAgentSelection }).strict();
const Control = z.object({ id: LearningId, action: z.enum(["pause", "resume", "cancel", "feedback"]), eventId: LearningId,
  feedback: z.string().trim().min(1).max(2000).optional(), attemptId: LearningId.optional() }).strict();
export async function GET(request: Request, context: Context) {
  return withLearning(request, async learning => {
    const pageId = LearningId.parse((await context.params).pageId); learning.get(pageId);
    const store = openLearningAgentStore(learning);
    try { return learningJson({ tasks: store.listTasks(learning.accountId, pageId).map(t => projectLearningAgentTask(learning, t)) }); }
    catch (error) { return learningAgentFailure(error); } finally { store.close(); }
  });
}
export async function POST(request: Request, context: Context) {
  return withLearning(request, async learning => {
    const pageId = LearningId.parse((await context.params).pageId), value = Start.parse(await learningJsonBody(request));
    const store = openLearningAgentStore(learning);
    try {
      agentModelConfig(); learningAgentGenerationConfig();
      const scope = freezeLearningAgentScope(learning, pageId, value.scope);
      const task = store.createTask({ id: value.id, accountId: learning.accountId, resourceId: pageId, scenario: "learning.adaptive-review.v1", goal: value.goal, scope });
      const root = learning.accountDataRoot, accountId = learning.accountId;
      if (task.status === "ready") after(() => advanceLearningAgent(root, accountId, task.id).then(() => undefined));
      return learningJson({ task: projectLearningAgentTask(learning, task) }, 202);
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
      let scheduled = false;
      if (value.action === "feedback") {
        const event = { id: value.eventId, kind: value.attemptId ? (value.feedback ? "quiz_dispute" : "quiz_submission") : "feedback", refId: value.attemptId, message: value.feedback };
        // Repeated accepted events are read-only receipts, including after the
        // task reached a different wait or ended. Never trigger another decision.
        const accepted = store.acceptedEvent(accountId, task.id, event);
        if (!accepted?.consumed) {
          if (task.status !== "waiting") throw new LearningError(409, "agent_feedback_not_ready");
          await createLearningAgentScenario(learning).validateEvent!(event, {
            task, actionId: "api-validation", signal: new AbortController().signal,
            assertActive: async () => undefined, call: async () => { throw new AgentFailure("forbidden", "api_validation_has_no_model_calls"); }
          } as AgentContext);
          after(() => advanceLearningAgent(root, accountId, task.id, event).then(() => undefined));
          scheduled = true;
        }
      } else {
        task = store.control(accountId, task.id, value.action);
        if (value.action === "resume" && task.status === "ready") { after(() => advanceLearningAgent(root, accountId, task.id).then(() => undefined)); scheduled = true; }
      }
      return learningJson({ task: projectLearningAgentTask(learning, task), scheduled }, 202);
    } catch (error) { return learningAgentFailure(error); } finally { store.close(); }
  });
}
