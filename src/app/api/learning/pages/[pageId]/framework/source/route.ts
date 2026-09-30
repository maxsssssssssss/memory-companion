import { z } from "zod";
import { LearningId } from "@/lib/domain/learning";
import { LearningFrameworkRepository } from "@/lib/server/learning/framework-repository";
import { learningJson, withLearning } from "../../../../route-utils";

export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ pageId: string }> }) {
  return withLearning(request, async (repo) => {
    const query = new URL(request.url).searchParams;
    const source = new LearningFrameworkRepository(repo).source(LearningId.parse((await context.params).pageId),
      LearningId.parse(query.get("chapter")), LearningId.parse(query.get("node")), z.coerce.number().int().nonnegative().parse(query.get("index")));
    return learningJson({ source });
  });
}
