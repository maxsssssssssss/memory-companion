import { z } from "zod";
import { LearningId } from "@/lib/domain/learning";
import { LearningStudyRepository } from "@/lib/server/learning/study-repository";
import { learningJson, withLearning } from "../../../route-utils";
export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ pageId: string }> }) {
  return withLearning(request, async repo => {
    const q = new URL(request.url).searchParams, index = z.coerce.number().int().min(0).max(1000);
    return learningJson({ source: new LearningStudyRepository(repo).readSource(LearningId.parse((await context.params).pageId),
      z.enum(["overview", "answer"]).parse(q.get("kind")), LearningId.parse(q.get("id")), index.parse(q.get("item")), index.parse(q.get("index"))) });
  });
}
