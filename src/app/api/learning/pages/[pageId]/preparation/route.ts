import { after } from "next/server";
import { LearningId } from "@/lib/domain/learning";
import { listLearningPreparations, resumeLearningPreparation } from "@/lib/server/learning/preparation-service";
import { learningJson, learningJsonBody, withLearning } from "../../../route-utils";

export const runtime = "nodejs";
type Context = { params: Promise<{pageId:string}> };
export async function GET(request:Request,context:Context) {
  return withLearning(request,async repo => learningJson({runs:listLearningPreparations(repo,LearningId.parse((await context.params).pageId))}));
}
export async function POST(request:Request,context:Context) {
  return withLearning(request,async repo => learningJson({run:resumeLearningPreparation(repo,LearningId.parse((await context.params).pageId),await learningJsonBody(request),work=>after(()=>work))}));
}
