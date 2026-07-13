import { extractBriefItems } from "@/lib/processing/extract-rule-based";
import type { ExtractionProvider } from "./provider";

export const ruleExtractionProvider: ExtractionProvider = {
  async extract(uploadId, segments) {
    return extractBriefItems(uploadId, segments);
  }
};
