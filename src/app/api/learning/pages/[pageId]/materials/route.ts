import { LEARNING_AUDIO_MAX_BYTES, LEARNING_AUDIO_BATCH_MAX_BYTES, LEARNING_BATCH_MAX_BYTES, LEARNING_PDF_BATCH_MAX_BYTES, LEARNING_PDF_MAX_BYTES, LEARNING_TEXT_MAX_BYTES, LearningBatch, LearningId } from "@/lib/domain/learning";
import { LearningError, type LearningOriginalInput } from "@/lib/server/learning/repository";
import { inspectLearningAudio, learningAudioTempPath } from "@/lib/server/learning/audio-files";
import { inspectLearningPdf } from "@/lib/server/learning/pdf-inspect";
import { after } from "next/server";
import { prepareLearningUpload } from "@/lib/server/learning/upload-preparation";
import { recordLearningPreparation, startLearningPreparation } from "@/lib/server/learning/preparation-service";
import { boundedLearningBody, learningJson, withLearning } from "../../../route-utils";

export const runtime = "nodejs";
// A process-local resource cap, not a queue: excess submissions can retry their IDs.
let activeUploads = 0;
export async function POST(request: Request, context: { params: Promise<{ pageId: string }> }) {
  return withLearning(request, async (repository) => {
    const pageId = LearningId.parse((await context.params).pageId);
    repository.get(pageId); // Reject foreign/deleted pages before reading a body.
    if (activeUploads >= 2) throw new LearningError(503, "learning_upload_busy");
    activeUploads++;
    try {
    const bytes = await boundedLearningBody(request, LEARNING_AUDIO_BATCH_MAX_BYTES + LEARNING_BATCH_MAX_BYTES + LEARNING_PDF_BATCH_MAX_BYTES + 128 * 1024, "learning_upload_too_large");
    let form: FormData;
    try {
      form = await new Response(Buffer.from(bytes), { headers: { "content-type": request.headers.get("content-type") ?? "" } }).formData();
    } catch { throw new LearningError(400, "invalid_input"); }
    const raw = form.get("materials");
    if (typeof raw !== "string" || form.getAll("materials").length !== 1) throw new LearningError(400, "invalid_input");
    const metadata = LearningBatch.parse(JSON.parse(raw));
    const files = form.getAll("files");
    const process = form.get("prepare");
    if (form.getAll("prepare").length > 1 || (process !== null && process !== "yes" && process !== "no")) throw new LearningError(400, "invalid_input");
    const intent = form.get("intent");
    if (form.getAll("intent").length > 1 || (intent !== null && !["organize", "prepare", "save"].includes(String(intent))) || (intent !== null && process !== null)) throw new LearningError(400,"invalid_input");
    if (files.length !== metadata.length || Array.from(form.keys()).some((key) => !["materials", "files", "prepare", "intent"].includes(key))) throw new LearningError(400, "invalid_input");
    let pdfSize = 0; let textSize = 0; let audioSize = 0;
    for (let index = 0; index < files.length; index++) {
      const file = files[index];
      if (typeof file === "string") throw new LearningError(400, "invalid_input");
      const pdf = metadata[index].kind === "pdf"; const audio = metadata[index].kind === "audio";
      if (file.size > (audio ? LEARNING_AUDIO_MAX_BYTES : pdf ? LEARNING_PDF_MAX_BYTES : LEARNING_TEXT_MAX_BYTES)) throw new LearningError(413, audio ? "audio_too_large" : pdf ? "pdf_too_large" : "text_too_large");
      if (audio) audioSize += file.size; else if (pdf) pdfSize += file.size; else textSize += file.size;
    }
    if (pdfSize > LEARNING_PDF_BATCH_MAX_BYTES) throw new LearningError(413, "pdf_batch_too_large");
    if (textSize > LEARNING_BATCH_MAX_BYTES) throw new LearningError(413, "batch_too_large");
    if (audioSize > LEARNING_AUDIO_BATCH_MAX_BYTES) throw new LearningError(413, "audio_batch_too_large");
    const materials: LearningOriginalInput[] = [];
    // Sequential, bounded inspection; no source persists until the whole transaction.
    for (let index = 0; index < metadata.length; index++) {
      const item = metadata[index];
      const file = files[index];
      if (typeof file === "string") throw new LearningError(400, "invalid_input");
      repository.assertMaterialWritable(pageId, item.id);
      const original = Buffer.from(await file.arrayBuffer());
      if (item.kind === "pdf") materials.push({ ...item, kind: "pdf", filename: file.name, bytes: original, pdf: await inspectLearningPdf(original, request.signal) });
      else if (item.kind === "audio") materials.push({ ...item, kind: "audio", filename: file.name, bytes: original, audio: await inspectLearningAudio(original, file.name, file.type, request.signal, { directory: learningAudioTempPath(repository.accountDataRoot, pageId, item.id), assertWritable: () => repository.assertMaterialWritable(pageId, item.id) }) });
      else materials.push({ ...item, kind: item.kind, filename: item.kind === "txt" ? file.name : null, bytes: original });
    }
    if (request.signal.aborted) throw new LearningError(408, "pdf_interrupted");
    const ids = materials.map(m=>m.id);
    repository.database.transaction(() => {
      repository.saveMaterials(pageId, materials);
      if (intent === "organize" || intent === "prepare") {
        recordLearningPreparation(repository,pageId,ids,intent);
        // Select this batch while handling its explicit upload action; background
        // preparation never changes a user's later selection.
        const page = repository.get(pageId);
        repository.select(pageId,{revision:page.revision,materialIds:[...new Set([...page.materials.filter(m=>m.selected).map(m=>m.id),...ids])]});
      }
    }).immediate();
    const run = intent === "organize" || intent === "prepare" ? startLearningPreparation(repository,pageId,ids,work=>after(()=>work),undefined,intent) : undefined;
    const preparation = process === "yes"
      ? prepareLearningUpload(repository, pageId, materials.map(m => m.id), work => after(() => work)) : [];
    return learningJson({ page: repository.get(pageId), preparation, ...(run ? {run} : {}) });
    } finally { activeUploads--; }
  });
}
