import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { LEARNING_PDF_MAX_BYTES, LEARNING_PDF_MAX_PAGES, type LearningPdfMetadata } from "@/lib/domain/learning";
import { LearningError } from "./repository";

// Keep resolution in Node: Webpack rewrites imported createRequire.resolve into
// bundle IDs, which are not filesystem paths usable by the isolated worker.
const requirePdf = process.getBuiltinModule("node:module").createRequire(join(process.cwd(), "package.json"));
export const learningPdfAssetRoot = () => dirname(requirePdf.resolve("pdfjs-dist/package.json"));

// Only our fixed program is evaluated, never document content. A disposable worker
// bounds CPU time / JS heap and keeps hostile or damaged PDFs off the request thread.
const INSPECT = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  let task; let parserLoaded = false; let oversizedImage = false; let parseWarning = false; let physicalPage = 0;
  const compatibilityWarnings = [];
  try {
    // PDF.js 6 may resolve an empty operator list before rejecting its stream.
    // Use its warning-producing recovery path, then fail closed on content warnings.
    // The narrow exceptions below retain content; neither permits a skipped page.
    console.log = console.warn = (...values) => {
      if (parserLoaded) {
        // PDF.js retains the entire Name token (Lexer.getName -> Name.get).
        // Keep its bounded spec-length notice separate from skipped-content warnings.
        const match = values.length === 1 && typeof values[0] === 'string'
          ? /^Warning: Name token is longer than allowed by the spec: (\d+)$/.exec(values[0]) : null;
        const hint = values.length === 1 && typeof values[0] === 'string'
          ? /^Warning: TT: undefined function: (\d+)$/.exec(values[0]) : null;
        if (match && Number(match[1]) > 127 && Number(match[1]) <= 1024 && compatibilityWarnings.length < 1000) {
          compatibilityWarnings.push({ code: 'long_name_preserved', physicalPage, length: Number(match[1]) });
        } else if (hint && Number(hint[1]) <= 65535 && compatibilityWarnings.length < 1000) {
          // PDF.js checkInvalidFunctions marks hintsValid=false. Its font sanitizer
          // removes fpgm/prep/cvt and glyph hint instructions, retaining glyph outlines.
          // Do not extend this exception to missing glyphs, damaged streams or other TT warnings.
          compatibilityWarnings.push({ code: 'font_hinting_removed', physicalPage, functionId: Number(hint[1]) });
        } else parseWarning = true;
      }
      if (values.some(value => typeof value === 'string' && value.includes('Image exceeded maximum allowed size'))) oversizedImage = true;
    };
    globalThis.fetch = () => { throw new Error('network_disabled'); };
    const pdfjs = await import(workerData.moduleUrl);
    parserLoaded = true;
    task = pdfjs.getDocument({ data: workerData.bytes, verbosity: 1,
      stopAtErrors: false, enableXfa: false, useWorkerFetch: false, maxImageSize: 16000000,
      cMapUrl: workerData.assets + '/cmaps/', cMapPacked: true,
      standardFontDataUrl: workerData.assets + '/standard_fonts/',
      wasmUrl: workerData.assets + '/wasm/', iccUrl: workerData.assets + '/iccs/' });
    const document = await task.promise;
    const { info } = await document.getMetadata();
    if (info.EncryptFilterName) throw new Error('pdf_encrypted');
    if (info.IsXFAPresent || document.isPureXfa) throw new Error('pdf_unsupported');
    if (!document.numPages || document.numPages > workerData.maxPages) throw new Error('pdf_page_limit');
    const pages = [];
    for (let number = 1; number <= document.numPages; number++) {
      physicalPage = number;
      const page = await document.getPage(number);
      const viewport = page.getViewport({ scale: 1 });
      if (![viewport.width, viewport.height, page.userUnit, ...page.view].every(Number.isFinite)
        || viewport.width <= 0 || viewport.height <= 0 || viewport.width > 14400 || viewport.height > 14400) throw new Error('pdf_unsupported');
      // Check page content streams, without extracting text, OCR or executing actions.
      await page.getOperatorList();
      if (oversizedImage) throw new Error('pdf_image_limit');
      if (parseWarning) throw new Error('pdf_incomplete');
      pages.push({ physicalPage: number, width: viewport.width, height: viewport.height,
        rotation: page.rotate, view: page.view, userUnit: page.userUnit });
      page.cleanup();
    }
    parentPort.postMessage({ pages, compatibilityWarnings });
  } catch (error) {
    const known = ['pdf_encrypted', 'pdf_unsupported', 'pdf_page_limit', 'pdf_image_limit', 'pdf_incomplete'];
    parentPort.postMessage({ error: !parserLoaded ? 'pdf_validator_unavailable' : error.name === 'PasswordException' ? 'pdf_encrypted'
      : error.message?.includes('Image exceeded maximum allowed size') ? 'pdf_image_limit'
      : known.includes(error.message) ? error.message : 'invalid_pdf' });
  } finally { await task?.destroy(); }
})();`;

export async function inspectLearningPdf(bytes: Buffer, signal?: AbortSignal): Promise<LearningPdfMetadata> {
  if (bytes.length > LEARNING_PDF_MAX_BYTES) throw new LearningError(413, "pdf_too_large");
  if (!/^%PDF-\d\.\d[\r\n]/u.test(bytes.subarray(0, 16).toString("ascii"))
    || !/%%EOF\s*$/u.test(bytes.subarray(-1024).toString("latin1"))) throw new LearningError(400, "invalid_pdf");
  if (signal?.aborted) throw new LearningError(408, "pdf_interrupted");
  const copy = Uint8Array.from(bytes);
  const worker = new Worker(INSPECT, {
    eval: true, stdout: true, stderr: true,
    workerData: { bytes: copy, maxPages: LEARNING_PDF_MAX_PAGES,
      moduleUrl: pathToFileURL(join(learningPdfAssetRoot(), "legacy/build/pdf.mjs")).href,
      assets: learningPdfAssetRoot().replaceAll("\\", "/") },
    transferList: [copy.buffer], resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 8 }
  });
  // Never log parser output: it can contain fragments of the supplied document.
  worker.stdout?.resume(); worker.stderr?.resume();
  let compatibilityWarnings: NonNullable<LearningPdfMetadata["compatibilityWarnings"]> = [];
  const pages = await new Promise<LearningPdfMetadata["pages"]>((resolve, reject) => {
    let finished = false;
    const finish = (error?: LearningError, value?: LearningPdfMetadata["pages"]) => {
      if (finished) return;
      finished = true; clearTimeout(timer); signal?.removeEventListener("abort", abort);
      void worker.terminate().then(() => { if (error) reject(error); else resolve(value!); });
    };
    const abort = () => finish(new LearningError(408, "pdf_interrupted"));
    const timer = setTimeout(() => finish(new LearningError(422, "pdf_resource_limit")), 20000);
    signal?.addEventListener("abort", abort, { once: true });
    worker.once("message", (result: { error?: string; pages: LearningPdfMetadata["pages"]; compatibilityWarnings?: LearningPdfMetadata["compatibilityWarnings"] }) => {
      compatibilityWarnings = result.compatibilityWarnings ?? [];
      if (result.error) finish(new LearningError(result.error === "pdf_validator_unavailable" ? 503 : 422, result.error)); else finish(undefined, result.pages);
    });
    worker.once("error", () => finish(new LearningError(422, "pdf_resource_limit")));
    worker.once("exit", () => { if (!finished) finish(new LearningError(422, "pdf_resource_limit")); });
  });
  return { sha256: createHash("sha256").update(bytes).digest("hex"), originalVersion: 1,
    pageCount: pages.length, pages, parsing: "not_parsed", ...(compatibilityWarnings.length ? { compatibilityWarnings } : {}) };
}
