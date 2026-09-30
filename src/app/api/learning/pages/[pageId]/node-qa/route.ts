import { LearningId } from "@/lib/domain/learning";
import { LearningStudyRepository } from "@/lib/server/learning/study-repository";
import { answerLearningNode } from "@/lib/server/learning/study-service";
import { learningJson, learningJsonBody, withLearning } from "../../../route-utils";
export const runtime = "nodejs";
type Context = { params: Promise<{ pageId: string }> };
export async function GET(request: Request, context: Context) {
  return withLearning(request, async repo => {
    const query = new URL(request.url).searchParams;
    return learningJson({ conversations: new LearningStudyRepository(repo).conversations(LearningId.parse((await context.params).pageId), LearningId.parse(query.get("chapter")), LearningId.parse(query.get("node"))) });
  });
}
export async function POST(request: Request, context: Context) {
  return withLearning(request, async repo => learningJson({ conversations: await answerLearningNode(repo, LearningId.parse((await context.params).pageId), await learningJsonBody(request)) }));
}
export async function PATCH(request: Request, context: Context) {
  return withLearning(request, async repo => learningJson({ framework: new LearningStudyRepository(repo).saveNote(LearningId.parse((await context.params).pageId), await learningJsonBody(request)) }));
}
