import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PHASE_3_1_RANKING_REGRESSIONS,
  PHASE_3_1_REGRESSION_CASE_IDS
} from "./ranking-regression-fixture";

describe("Phase 3.1 ranking regression fixture", () => {
  it("freezes the twelve independent regression cases and universe gaps", () => {
    expect(PHASE_3_1_RANKING_REGRESSIONS).toHaveLength(12);
    expect(PHASE_3_1_REGRESSION_CASE_IDS.size).toBe(12);
    expect(
      PHASE_3_1_RANKING_REGRESSIONS.map((item) => item.caseId)
    ).toEqual([
      "c02", "c11", "c12", "c19", "w01", "w12",
      "w13", "w16", "a01", "a04", "a05", "a09"
    ]);
    expect(
      PHASE_3_1_RANKING_REGRESSIONS.find((item) => item.caseId === "a09")
        ?.universeGapGoldGroupCount
    ).toBe(1);
    expect(
      PHASE_3_1_RANKING_REGRESSIONS.every((item) =>
        item.question.length > 0 &&
        item.goldGroups.length > 0 &&
        item.expectedOrderingInvariants.length > 0
      )
    ).toBe(true);
  });

  it("does not hard-code fixture case or gold IDs in production ranking", async () => {
    const rankingSource = await readFile(
      resolve(
        process.cwd(),
        "src/lib/server/retrieval/hybrid/evidence-ranking.ts"
      ),
      "utf8"
    );
    for (const item of PHASE_3_1_RANKING_REGRESSIONS) {
      expect(rankingSource).not.toContain(`"${item.caseId}"`);
      expect(rankingSource).not.toContain(item.baseline.goldEvidenceId);
    }
  });
});
