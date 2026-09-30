import { parseLearningPdf, pdfParseProgress } from "@/lib/server/learning/pdf-parser-service";
import { z } from "zod";
import { LearningId } from "@/lib/domain/learning";
import { PdfStudySelection } from "@/lib/domain/learning-pdf-study";
import { LearningError } from "@/lib/server/learning/repository";
import { inspectLearningPdfReadiness } from "@/lib/server/learning/pdf-readiness";
import { withLearning, learningJson, learningJsonBody } from "../../../../../route-utils";
export const runtime = "nodejs";
type Context = { params: Promise<{pageId:string;materialId:string}> };
export async function GET(request:Request, context:Context) {
  return withLearning(request,async repo=>{
    const p=await context.params, pageId=LearningId.parse(p.pageId),materialId=LearningId.parse(p.materialId);
    repo.pdfOriginal(pageId,materialId,false);
    const documents=repo.listParsedDocuments(pageId,materialId);
    const selected=new URL(request.url).searchParams.get("document");
    const id=selected?LearningId.parse(selected):documents.at(-1)?.id;
    if(new URL(request.url).searchParams.get("summary")==="1") {
      if(id&&!documents.some(d=>d.id===id))throw new LearningError(404,"parsed_document_not_found");
      return learningJson({documents,document:null,progress:id?pdfParseProgress(repo,pageId,id):[],selection:repo.get(pageId).materials.find(m=>m.id===materialId)?.pdfStudy??null,readiness:inspectLearningPdfReadiness(repo,pageId,materialId,id)});
    }
    const document=id?repo.getParsedDocument(pageId,id):null;
    if(document&&document.materialId!==materialId)throw new LearningError(404,"parsed_document_not_found");
    const blockId=new URL(request.url).searchParams.get("block");
    if(blockId&&document)return learningJson(repo.parsedBlockSource(pageId,document.id,LearningId.parse(blockId)));
    return learningJson({documents,document,progress:document?pdfParseProgress(repo,pageId,document.id):[],selection:repo.get(pageId).materials.find(m=>m.id===materialId)?.pdfStudy??null,readiness:inspectLearningPdfReadiness(repo,pageId,materialId,id)});
  });
}
export async function PATCH(request:Request,context:Context){
  return withLearning(request,async repo=>{
    const p=await context.params;
    const value=z.object({revision:z.number().int().nonnegative(),selection:PdfStudySelection}).strict().parse(await learningJsonBody(request));
    return learningJson({page:repo.selectPdfStudy(LearningId.parse(p.pageId),LearningId.parse(p.materialId),value.selection,value.revision)});
  });
}

export async function POST(request:Request,context:Context){
  return withLearning(request,async repo=>{const p=await context.params;return learningJson(await parseLearningPdf(repo,LearningId.parse(p.pageId),LearningId.parse(p.materialId),await learningJsonBody(request)));});
}
