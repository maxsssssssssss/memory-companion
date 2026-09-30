import { LearningId } from "@/lib/domain/learning";
import { LearningAudioRepository } from "@/lib/server/learning/audio-repository";
import { transcribeLearningAudio } from "@/lib/server/learning/audio-service";
import { learningJson, learningJsonBody, withLearning } from "../../../route-utils";
export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ pageId: string }> }) {
  return withLearning(request, async (repository) => learningJson({ runs: new LearningAudioRepository(repository).list(LearningId.parse((await context.params).pageId)) }));
}
export async function POST(request: Request, context: { params: Promise<{ pageId: string }> }) {
  return withLearning(request, async (repository) => learningJson(await transcribeLearningAudio(repository,
    LearningId.parse((await context.params).pageId), await learningJsonBody(request))));
}
