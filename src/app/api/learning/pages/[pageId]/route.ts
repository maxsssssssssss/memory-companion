import { cleanupLearningAudioTemp } from "@/lib/server/learning/audio-files";
import { LearningId, LearningSelection } from "@/lib/domain/learning";
import { learningJson, learningJsonBody, withLearning } from "../../route-utils";

export const runtime = "nodejs";
type Context = { params: Promise<{ pageId: string }> };
export async function GET(request: Request, context: Context) {
  return withLearning(request, async (repository) => learningJson({ page: repository.get(LearningId.parse((await context.params).pageId)) }));
}
export async function PATCH(request: Request, context: Context) {
  return withLearning(request, async (repository) => learningJson({ page: repository.select(
    LearningId.parse((await context.params).pageId), LearningSelection.parse(await learningJsonBody(request))) }));
}
export async function DELETE(request: Request, context: Context) {
  return withLearning(request, async (repository) => {
    const pageId = LearningId.parse((await context.params).pageId);
    repository.deletePage(pageId);
    await cleanupLearningAudioTemp(repository.accountDataRoot, pageId);
    return learningJson({ deleted: true });
  });
}
