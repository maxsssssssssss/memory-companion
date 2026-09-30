import { CreateLearningPage } from "@/lib/domain/learning";
import { learningJson, learningJsonBody, withLearning } from "../route-utils";

export const runtime = "nodejs";
export async function GET(request: Request) {
  return withLearning(request, (repository) => learningJson({ pages: repository.list() }));
}
export async function POST(request: Request) {
  return withLearning(request, async (repository) => learningJson({ page: repository.create(CreateLearningPage.parse(await learningJsonBody(request))) }));
}
