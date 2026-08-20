import { describe, expect, it } from "vitest";

import {
  inspectToyIngestionRequest,
  parseToyIngestionRequest,
  resolveToyIngestionMode
} from "./toy-ingestion-receipt";

function metadata(input: Partial<{
  operationKey: string;
  destination: string;
  relationshipId: string;
  uploadContext: string;
  generation: string;
}> = {}) {
  const formData = new FormData();
  formData.set("toyOperationKey", input.operationKey ?? "operation_1");
  formData.set("toyDestination", input.destination ?? "date_companion");
  formData.set("toyRelationshipId", input.relationshipId ?? "relationship_1");
  formData.set("uploadContext", input.uploadContext ?? "date-companion");
  if (input.generation !== undefined) formData.set("toyGeneration", input.generation);
  return formData;
}

describe("minimal Toy ingestion metadata", () => {
  it("accepts only operation, destination and relationship as the active protocol", () => {
    expect(parseToyIngestionRequest(metadata())).toEqual({
      operationKey: "operation_1",
      destination: "date_companion",
      relationshipId: "relationship_1"
    });
    expect(inspectToyIngestionRequest(new FormData())).toEqual({ kind: "absent" });
  });

  it("rejects partial, unsafe and legacy generation metadata", () => {
    const partial = new FormData();
    partial.set("toyOperationKey", "operation_1");
    expect(inspectToyIngestionRequest(partial)).toMatchObject({ kind: "invalid" });
    expect(inspectToyIngestionRequest(metadata({ operationKey: "../unsafe" })))
      .toMatchObject({ kind: "invalid" });
    expect(inspectToyIngestionRequest(metadata({ generation: "0" })))
      .toMatchObject({ kind: "invalid" });
  });

  it("uses recovery as the only enabled mode and keeps shadow as a legacy alias", () => {
    expect(resolveToyIngestionMode(undefined)).toBe("off");
    expect(resolveToyIngestionMode(" off ")).toBe("off");
    expect(resolveToyIngestionMode("recovery")).toBe("recovery");
    expect(resolveToyIngestionMode(" SHADOW ")).toBe("recovery");
    expect(() => resolveToyIngestionMode("enforce")).toThrow(
      "DAILY_BRIEF_TOY_INGESTION_MODE must be off or recovery"
    );
    expect(() => resolveToyIngestionMode("unknown")).toThrow(
      "DAILY_BRIEF_TOY_INGESTION_MODE must be off or recovery"
    );
  });
});
