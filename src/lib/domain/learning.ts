import { z } from "zod";

// Request bounds, not limits on a learning page or on future learning content.
export const LEARNING_TEXT_MAX_BYTES = 1024 * 1024;
export const LEARNING_BATCH_MAX_BYTES = 4 * 1024 * 1024;
export const LEARNING_BATCH_MAX_FILES = 16;
// PDFs are read sequentially. Bound binary copies, SQLite transactions and parsing work.
export const LEARNING_PDF_MAX_BYTES = 20 * 1024 * 1024;
export const LEARNING_PDF_BATCH_MAX_BYTES = 50 * 1024 * 1024;
export const LEARNING_PDF_BATCH_MAX_FILES = 5;
export const LEARNING_PDF_MAX_PAGES = 200;
export const LEARNING_PDF_PARSE_MAX_PAGES = 30;
export type LearningUploadPreparation = {
  materialId: string;
  status: "started" | "already_started" | "needs_range" | "unavailable";
  error?: string;
};
// Bounded multipart/SQLite copies. Long originals remain in the database, not public files.
export const LEARNING_AUDIO_MAX_BYTES = 64 * 1024 * 1024;
export const LEARNING_AUDIO_BATCH_MAX_BYTES = 128 * 1024 * 1024;
export const LEARNING_AUDIO_MAX_SECONDS = 2 * 60 * 60;
export const LEARNING_AUDIO_BATCH_MAX_FILES = 2;
export const LearningId = z.string().uuid();
export const LearningTitle = z.string().trim().min(1).max(160);
export const CreateLearningPage = z.object({ id: LearningId, title: LearningTitle }).strict();
export const LearningMaterialInput = z.object({
  id: LearningId,
  title: LearningTitle,
  kind: z.enum(["text", "txt", "pdf", "audio"])
}).strict();
export const LearningBatch = z.array(LearningMaterialInput).min(1).max(LEARNING_BATCH_MAX_FILES + LEARNING_PDF_BATCH_MAX_FILES + LEARNING_AUDIO_BATCH_MAX_FILES)
  .refine((items) => new Set(items.map((item) => item.id)).size === items.length)
  .refine((items) => items.filter((item) => item.kind === "pdf").length <= LEARNING_PDF_BATCH_MAX_FILES
    && items.filter((item) => item.kind === "audio").length <= LEARNING_AUDIO_BATCH_MAX_FILES
    && items.filter((item) => item.kind === "text" || item.kind === "txt").length <= LEARNING_BATCH_MAX_FILES);
export const LearningSelection = z.object({
  revision: z.number().int().nonnegative(),
  materialIds: z.array(LearningId).max(10000).refine((ids) => new Set(ids).size === ids.length)
}).strict();

export type LearningPdfPage = {
  physicalPage: number; width: number; height: number; rotation: number;
  view: number[]; userUnit: number;
};
export type LearningPdfMetadata = {
  compatibilityWarnings?: Array<
    | { code: "long_name_preserved"; physicalPage: number; length: number }
    | { code: "font_hinting_removed"; physicalPage: number; functionId: number }
  >;
  sha256: string; pageCount: number; pages: LearningPdfPage[];
  // Immutable original, version 1. No OCR result or printed-page-number claim.
  originalVersion: 1; parsing: "not_parsed";
};
export type LearningMaterial = {
  id: string; title: string; kind: "text" | "txt" | "pdf" | "audio"; filename: string | null;
  byteLength: number; createdAt: string; selected: boolean;
  pdf?: LearningPdfMetadata;
  pdfStudy?: import("./learning-pdf-study").PdfStudySelection;
  audio?: LearningAudioMetadata;
};
export type LearningPageSummary = {
  id: string; title: string; createdAt: string; updatedAt: string; materialCount: number;
};
export type LearningPage = LearningPageSummary & { revision: number; materials: LearningMaterial[] };
export type LearningAudioMetadata = { sha256: string; mimeType: string; durationSeconds: number; originalVersion: 1;
  transcription: "not_transcribed" | "processing" | "completed" | "failed"; completedChunks: number; totalChunks: number; failure?: string };
export type LearningParagraph = { number: number; start: number; end: number; text: string; parsed?: import("./learning-pdf-study").ParsedTextBinding; startSeconds?: number; endSeconds?: number };
export type LearningSource = {
  material: LearningMaterial; text: string; paragraphs: LearningParagraph[];
  scopeNotice?: { kind: "pdf"; documentId: string; parseVersion: number; physicalPages: number[]; excludedPhysicalPages: number[]; excludedBlockIds: string[]; contentVerified: false; warningCodes: string[] };
};

export const LEARNING_DELETE_MATERIAL_NOTICE = "将删除这份材料及其解析内容，但保留已有知识框架、题组和学习记录。相关原文将无法回看，已有成果中可能仍包含材料摘录。";

/** Blank lines delimit paragraphs; offsets refer to the unchanged decoded source. */
export function learningParagraphs(text: string): LearningParagraph[] {
  const paragraphs: LearningParagraph[] = [];
  const separator = /(?:\r\n|\n|\r(?!\n))[\t ]*(?:\r\n|\n|\r(?!\n))(?:[\t ]*(?:\r\n|\n|\r(?!\n)))*/g;
  let start = 0;
  const add = (end: number) => {
    if (text.slice(start, end).trim()) paragraphs.push({ number: paragraphs.length + 1, start, end, text: text.slice(start, end) });
  };
  for (const match of text.matchAll(separator)) {
    add(match.index);
    start = match.index + match[0].length;
  }
  add(text.length);
  return paragraphs;
}
