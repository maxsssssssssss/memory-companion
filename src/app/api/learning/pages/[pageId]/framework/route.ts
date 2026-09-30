import { LearningId } from "@/lib/domain/learning";
import { StartLearningFramework } from "@/lib/domain/learning-framework";
import { LearningFrameworkRepository } from "@/lib/server/learning/framework-repository";
import { organizeLearningText } from "@/lib/server/learning/framework-service";
import { LearningStudyRepository } from "@/lib/server/learning/study-repository";
import { updateLearningOverview } from "@/lib/server/learning/study-service";
import { LearningError } from "@/lib/server/learning/repository";
import { learningJson, learningJsonBody, withLearning } from "../../../route-utils";

export const runtime = "nodejs";
type Context = { params: Promise<{ pageId: string }> };
export async function GET(request: Request, context: Context) {
  return withLearning(request, async (repo) => learningJson({ framework: new LearningFrameworkRepository(repo).view(LearningId.parse((await context.params).pageId)) }));
}
export async function POST(request: Request, context: Context) {
  return withLearning(request, async (repo) => {
    const pageId = LearningId.parse((await context.params).pageId), input = StartLearningFramework.parse(await learningJsonBody(request));
    const study = new LearningStudyRepository(repo);
    const existing = new LearningFrameworkRepository(repo).existing(pageId, input);
    if (study.overview(pageId).latest?.status === "generating" && !existing) throw new LearningError(409, "overview_busy");
    const framework = await organizeLearningText(repo, pageId, input);
    let overviewError: string | undefined;
    if (!existing && framework.runs.find(r => r.id === input.id)?.status === "completed") try {
      await updateLearningOverview(repo, pageId, { id: input.id });
    } catch (e) { overviewError = e instanceof LearningError ? e.code : "framework_provider_failed"; }
    // Chapters have already committed; an independent overview failure never rolls them back.
    repo.get(pageId); // A page deleted during the follow-up must not receive a late response body.
    return learningJson({ framework, ...(overviewError ? { overviewError } : {}) });
  });
}
export async function PATCH(request: Request, context: Context) {
  return withLearning(request, async (repo) => learningJson({ framework: new LearningFrameworkRepository(repo).edit(
    LearningId.parse((await context.params).pageId), await learningJsonBody(request)) }));
}
