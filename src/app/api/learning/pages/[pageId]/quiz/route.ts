import { z } from "zod";
import { after } from "next/server";
import { LearningId } from "@/lib/domain/learning";
import { BeginQuizAttempt, QuizAction } from "@/lib/domain/learning-quiz";
import { LearningQuizRepository } from "@/lib/server/learning/quiz-repository";
import { generateLearningQuiz, startLearningQuiz } from "@/lib/server/learning/quiz-service";
import { learningJson, learningJsonBody, withLearning } from "../../../route-utils";
export const runtime = "nodejs";
type Context = { params: Promise<{ pageId: string }> };
export async function GET(request: Request, context: Context) {
  return withLearning(request, async learning => {
    const pageId = LearningId.parse((await context.params).pageId), repo = new LearningQuizRepository(learning), q = new URL(request.url).searchParams;
    if (!q.has("attempt")) return learningJson({ quizzes: repo.list(pageId) });
    const id = LearningId.parse(q.get("attempt"));
    if (q.has("source")) return learningJson({ source: repo.readSource(pageId, id, z.coerce.number().int().min(0).max(49).parse(q.get("question")), z.coerce.number().int().min(0).max(99).parse(q.get("source"))) });
    return learningJson({ attempt: repo.attempt(pageId, id) });
  });
}
export async function POST(request: Request, context: Context) {
  return withLearning(request, async learning => {
    const pageId=LearningId.parse((await context.params).pageId),input=await learningJsonBody(request);
    return learningJson({quizzes:request.headers.get("prefer")==="respond-async"
      ?startLearningQuiz(learning,pageId,input,work=>after(()=>work)) :await generateLearningQuiz(learning,pageId,input)});
  });
}
export async function PATCH(request: Request, context: Context) {
  return withLearning(request, async learning => {
    const pageId = LearningId.parse((await context.params).pageId), repo = new LearningQuizRepository(learning);
    const value = z.discriminatedUnion("kind", [z.object({ kind: z.literal("start"), value: BeginQuizAttempt }).strict(), z.object({ kind: z.literal("act"), value: QuizAction }).strict()]).parse(await learningJsonBody(request));
    return learningJson({ attempt: value.kind === "start" ? repo.startAttempt(pageId, value.value) : repo.act(pageId, value.value) });
  });
}
export async function DELETE(request: Request, context: Context) {
  return withLearning(request, async learning => {
    const pageId = LearningId.parse((await context.params).pageId), repo = new LearningQuizRepository(learning);
    const { id } = z.object({ id: LearningId }).strict().parse(await learningJsonBody(request));
    repo.delete(pageId, id);
    return learningJson({ quizzes: repo.list(pageId) });
  });
}
