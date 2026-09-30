import { LearningId } from "@/lib/domain/learning";
import { LearningStudyRepository } from "@/lib/server/learning/study-repository";
import { updateLearningOverview } from "@/lib/server/learning/study-service";
import { learningJson, learningJsonBody, withLearning } from "../../../route-utils";
export const runtime = "nodejs";
type Context = { params: Promise<{ pageId: string }> };
export async function GET(request: Request, context: Context) {
  return withLearning(request, async repo => learningJson({ overview: new LearningStudyRepository(repo).overview(LearningId.parse((await context.params).pageId)) }));
}
export async function POST(request: Request, context: Context) {
  return withLearning(request, async repo => learningJson({ overview: await updateLearningOverview(repo, LearningId.parse((await context.params).pageId), await learningJsonBody(request)) }));
}
