// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { syntheticLearningPdf } from "../../../../scripts/fixtures/learning-pdf.mjs";
import { inspectLearningPdf } from "./pdf-inspect";
import { LEARNING_PDF_MAX_BYTES } from "@/lib/domain/learning";

describe("local PDF inspection (synthetic originals only)", () => {
  it("reads physical page geometry, rotation and exact hash, including an image-only page without OCR", async () => {
    const bytes = syntheticLearningPdf({ javascript: true });
    const before = Buffer.from(bytes);
    const result = await inspectLearningPdf(bytes);
    expect(bytes).toEqual(before);
    expect(result).toMatchObject({ originalVersion: 1, parsing: "not_parsed", pageCount: 3, sha256: createHash("sha256").update(bytes).digest("hex") });
    expect(result.pages[0]).toMatchObject({ physicalPage: 1, width: 600, height: 800, rotation: 0 });
    expect(result.pages[1]).toMatchObject({ physicalPage: 2, width: 760, height: 580, rotation: 90, view: [10, 20, 590, 780] });
    expect(result).not.toHaveProperty("text");
    expect(globalThis).not.toHaveProperty("SYNTHETIC_PDF_SCRIPT_EXECUTED");
  }, 30000);
  it.each(["synthetic-password", ""])("rejects encrypted PDFs, including empty user password (%s)", async (password) => {
    await expect(inspectLearningPdf(syntheticLearningPdf({ password }))).rejects.toMatchObject({ code: "pdf_encrypted" });
  }, 30000);
  it("rejects wrong content, truncation, broken objects and resource bounds", async () => {
    for (const bytes of [Buffer.from("not a PDF"), syntheticLearningPdf().subarray(0, 100), Buffer.from("%PDF-1.7\nTHIS IS DAMAGED\n%%EOF\n")]) {
      await expect(inspectLearningPdf(bytes)).rejects.toMatchObject({ code: "invalid_pdf" });
    }
    await expect(inspectLearningPdf(Buffer.alloc(LEARNING_PDF_MAX_BYTES + 1))).rejects.toMatchObject({ code: "pdf_too_large" });
    await expect(inspectLearningPdf(syntheticLearningPdf({ pages: 201 }))).rejects.toMatchObject({ code: "pdf_page_limit" });
  }, 30000);
  it("allows only intact bounded long-name notices, still rejects unknown filters and pathological names", async () => {
    const result = await inspectLearningPdf(syntheticLearningPdf({ nameLength: 200 }));
    expect(result.compatibilityWarnings).toContainEqual({ code: "long_name_preserved", length: 200, physicalPage: 0 });
    await expect(inspectLearningPdf(syntheticLearningPdf({ nameLength: 1025 }))).rejects.toMatchObject({ code: "pdf_incomplete" });
    await expect(inspectLearningPdf(syntheticLearningPdf({ nameLength: 200, brokenFilter: true }))).rejects.toMatchObject({ code: "pdf_incomplete" });
  }, 30000);
  it("cancels a pending inspection without returning a publishable result", async () => {
    const controller = new AbortController();
    const pending = inspectLearningPdf(syntheticLearningPdf(), controller.signal); controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "pdf_interrupted" });
  });
  it("retains originals with recoverable font hint warnings, without accepting damaged content streams", async () => {
    const bytes = syntheticLearningPdf({ undefinedFontFunction: true });
    const before = Buffer.from(bytes);
    const result = await inspectLearningPdf(bytes);
    expect(result.pageCount).toBe(3);
    expect(result.compatibilityWarnings).toEqual([{ code: "font_hinting_removed", physicalPage: 1, functionId: 3 }]);
    expect(result.sha256).toBe(createHash("sha256").update(before).digest("hex"));
    expect(bytes).toEqual(before);
    expect(result.parsing).toBe("not_parsed");
    await expect(inspectLearningPdf(syntheticLearningPdf({ undefinedFontFunction: true, brokenFilter: true })))
      .rejects.toMatchObject({ code: "pdf_incomplete" });
  }, 30000);
  it("rejects unsupported XFA and oversized images instead of silently dropping their content", async () => {
    await expect(inspectLearningPdf(syntheticLearningPdf({ xfa: true }))).rejects.toMatchObject({ code: "pdf_unsupported" });
    await expect(inspectLearningPdf(syntheticLearningPdf({ oversizedImage: true }))).rejects.toMatchObject({ code: "pdf_image_limit" });
  }, 30000);
});
