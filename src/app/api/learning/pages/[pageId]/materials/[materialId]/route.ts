import { cleanupLearningAudioTemp } from "@/lib/server/learning/audio-files";
import { cleanupLearningPdfSources } from "@/lib/server/learning/pdf-parser-service";
import { LearningId } from "@/lib/domain/learning";
import { learningJson, withLearning } from "../../../../route-utils";

export const runtime = "nodejs";
type Context = { params: Promise<{ pageId: string; materialId: string }> };
export async function GET(request: Request, context: Context) {
  return withLearning(request, async (repository) => {
    const params = await context.params;
    return learningJson({ source: repository.source(LearningId.parse(params.pageId), LearningId.parse(params.materialId)) });
  });
}
export async function DELETE(request: Request, context: Context) {
  return withLearning(request, async (repository) => {
    const params = await context.params;
    const page = repository.deleteMaterial(LearningId.parse(params.pageId), LearningId.parse(params.materialId));
    await cleanupLearningAudioTemp(repository.accountDataRoot, params.pageId, params.materialId);
    await cleanupLearningPdfSources(repository, params.pageId, params.materialId);
    return learningJson({ page });
  });
}
