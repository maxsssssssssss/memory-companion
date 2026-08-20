export type RankingRegressionCaseId =
  | "c02"
  | "c11"
  | "c12"
  | "c19"
  | "w01"
  | "w12"
  | "w13"
  | "w16"
  | "a01"
  | "a04"
  | "a05"
  | "a09";

export type RankingOrderingInvariant =
  | "preserve_relevant_hybrid_top5"
  | "preserve_relevant_hybrid_top16"
  | "preserve_relevant_hybrid_top30"
  | "prefer_topic_consistent_final_state"
  | "preserve_lifecycle_chain";

export type RankingRegressionFixture = {
  caseId: RankingRegressionCaseId;
  question: string;
  scope: "current" | "week" | "all";
  category: string;
  queryIntent: string;
  goldGroups: string[][];
  baseline: {
    goldEvidenceId: string;
    hybridRank: number;
    optimizedRankingRank: number;
    bestGoldRankAfterRanking: number;
    failureReason: string;
    largestCompetitorFeature: string;
  };
  expectedOrderingInvariants: RankingOrderingInvariant[];
  universeGapGoldGroupCount: number;
};

/**
 * Executable regression data only. Production ranking must never import this
 * fixture, case IDs, questions, or gold IDs.
 */
export const PHASE_3_1_RANKING_REGRESSIONS: readonly RankingRegressionFixture[] = [
  {
    caseId: "c02",
    question: "简历检查的原始承诺截止到什么时候，检查哪些部分？",
    scope: "current",
    category: "decision",
    queryIntent: "commitment deadline and content",
    goldGroups: [
      ["8745ced0-0eca-4b90-b674-7cc4d64865b8_chunk_00000_seg_00011"],
      [
        "8745ced0-0eca-4b90-b674-7cc4d64865b8_chunk_00000_seg_00009",
        "8745ced0-0eca-4b90-b674-7cc4d64865b8_chunk_00000_seg_00016"
      ]
    ],
    baseline: {
      goldEvidenceId: "8745ced0-0eca-4b90-b674-7cc4d64865b8_brief_3",
      hybridRank: 1,
      optimizedRankingRank: 7,
      bestGoldRankAfterRanking: 4,
      failureReason: "relevant_evidence_rank_worsened",
      largestCompetitorFeature: "importance"
    },
    expectedOrderingInvariants: ["preserve_relevant_hybrid_top5"],
    universeGapGoldGroupCount: 0
  },
  {
    caseId: "c11",
    question: "取消后倾向改到哪一天，后续有哪两个明确选项？",
    scope: "current",
    category: "decision",
    queryIntent: "post-cancellation options and later state",
    goldGroups: [
      [],
      ["84626b28-b744-4bac-a6fb-09c07adbb730_chunk_00004_seg_00008"]
    ],
    baseline: {
      goldEvidenceId: "84626b28-b744-4bac-a6fb-09c07adbb730_chunk_00004_seg_00008",
      hybridRank: 5,
      optimizedRankingRank: 28,
      bestGoldRankAfterRanking: 8,
      failureReason: "relevant_evidence_rank_worsened",
      largestCompetitorFeature: "lifecycle"
    },
    expectedOrderingInvariants: [
      "preserve_relevant_hybrid_top5",
      "prefer_topic_consistent_final_state"
    ],
    universeGapGoldGroupCount: 1
  },
  {
    caseId: "c12",
    question: "关于计划变化，对方提出了什么沟通边界？",
    scope: "current",
    category: "relationship",
    queryIntent: "relationship communication boundary",
    goldGroups: [[
      "84626b28-b744-4bac-a6fb-09c07adbb730_chunk_00004_seg_00005",
      "84626b28-b744-4bac-a6fb-09c07adbb730_chunk_00004_seg_00006"
    ]],
    baseline: {
      goldEvidenceId: "84626b28-b744-4bac-a6fb-09c07adbb730_chunk_00004_seg_00005",
      hybridRank: 3,
      optimizedRankingRank: 19,
      bestGoldRankAfterRanking: 4,
      failureReason: "relevant_evidence_rank_worsened",
      largestCompetitorFeature: "lexical"
    },
    expectedOrderingInvariants: ["preserve_relevant_hybrid_top5"],
    universeGapGoldGroupCount: 0
  },
  {
    caseId: "c19",
    question: "博物馆计划最后落实了吗，结果是什么？",
    scope: "current",
    category: "lifecycle",
    queryIntent: "final lifecycle result",
    goldGroups: [[
      "a0b0656f-4036-4600-8c58-5fbb946a3bda_chunk_00008_seg_00009",
      "a0b0656f-4036-4600-8c58-5fbb946a3bda_chunk_00008_seg_00017"
    ]],
    baseline: {
      goldEvidenceId: "a0b0656f-4036-4600-8c58-5fbb946a3bda_chunk_00008_seg_00017",
      hybridRank: 1,
      optimizedRankingRank: 5,
      bestGoldRankAfterRanking: 2,
      failureReason: "relevant_evidence_rank_worsened",
      largestCompetitorFeature: "lifecycle"
    },
    expectedOrderingInvariants: [
      "preserve_relevant_hybrid_top5",
      "prefer_topic_consistent_final_state"
    ],
    universeGapGoldGroupCount: 0
  },
  {
    caseId: "w01",
    question: "第一周里简历检查从原承诺到延期发生了什么？",
    scope: "week",
    category: "lifecycle",
    queryIntent: "lifecycle sequence",
    goldGroups: [
      ["8745ced0-0eca-4b90-b674-7cc4d64865b8_chunk_00000_seg_00011"],
      [
        "ededf181-4b9b-4173-b23a-f9a306684764_chunk_00002_seg_00004",
        "ededf181-4b9b-4173-b23a-f9a306684764_chunk_00002_seg_00006",
        "ededf181-4b9b-4173-b23a-f9a306684764_chunk_00002_seg_00009"
      ]
    ],
    baseline: {
      goldEvidenceId:
        "semantic_8745ced0-0eca-4b90-b674-7cc4d64865b8_8745ced0-0eca-4b90-b674-7cc4d64865b8_chunk_00000_seg_00001_8745ced0-0eca-4b90-b674-7cc4d64865b8_chunk_00001_seg_00021",
      hybridRank: 1,
      optimizedRankingRank: 2,
      bestGoldRankAfterRanking: 2,
      failureReason: "relevant_evidence_rank_worsened",
      largestCompetitorFeature: "temporal"
    },
    expectedOrderingInvariants: [
      "preserve_relevant_hybrid_top5",
      "preserve_lifecycle_chain"
    ],
    universeGapGoldGroupCount: 0
  },
  {
    caseId: "w12",
    question: "第二周简历完整检查是否交付？",
    scope: "week",
    category: "lifecycle",
    queryIntent: "completion state",
    goldGroups: [[
      "ce1b3268-0f9e-42f8-bc18-5b73c7660489_chunk_00007_seg_00019",
      "ce1b3268-0f9e-42f8-bc18-5b73c7660489_chunk_00008_seg_00002"
    ]],
    baseline: {
      goldEvidenceId: "ce1b3268-0f9e-42f8-bc18-5b73c7660489_brief_25",
      hybridRank: 11,
      optimizedRankingRank: 17,
      bestGoldRankAfterRanking: 17,
      failureReason: "crossed_top_16_boundary",
      largestCompetitorFeature: "importance"
    },
    expectedOrderingInvariants: [
      "preserve_relevant_hybrid_top16",
      "prefer_topic_consistent_final_state"
    ],
    universeGapGoldGroupCount: 0
  },
  {
    caseId: "w13",
    question: "第二周的两条简历修改建议分别是什么？",
    scope: "week",
    category: "fact",
    queryIntent: "multi-fact coverage",
    goldGroups: [
      ["ce1b3268-0f9e-42f8-bc18-5b73c7660489_chunk_00007_seg_00021"],
      ["ce1b3268-0f9e-42f8-bc18-5b73c7660489_chunk_00007_seg_00023"]
    ],
    baseline: {
      goldEvidenceId: "ce1b3268-0f9e-42f8-bc18-5b73c7660489_brief_25",
      hybridRank: 11,
      optimizedRankingRank: 17,
      bestGoldRankAfterRanking: 17,
      failureReason: "crossed_top_16_boundary",
      largestCompetitorFeature: "temporal"
    },
    expectedOrderingInvariants: ["preserve_relevant_hybrid_top16"],
    universeGapGoldGroupCount: 0
  },
  {
    caseId: "w16",
    question: "第二周的证据如何解释博物馆计划曾调整以及最终为何算落实？",
    scope: "week",
    category: "decision",
    queryIntent: "lifecycle change and final rationale",
    goldGroups: [
      ["a0b0656f-4036-4600-8c58-5fbb946a3bda_chunk_00008_seg_00017"],
      ["a0b0656f-4036-4600-8c58-5fbb946a3bda_chunk_00008_seg_00017"]
    ],
    baseline: {
      goldEvidenceId: "a0b0656f-4036-4600-8c58-5fbb946a3bda_chunk_00008_seg_00017",
      hybridRank: 1,
      optimizedRankingRank: 4,
      bestGoldRankAfterRanking: 3,
      failureReason: "relevant_evidence_rank_worsened",
      largestCompetitorFeature: "importance"
    },
    expectedOrderingInvariants: [
      "preserve_relevant_hybrid_top5",
      "prefer_topic_consistent_final_state"
    ],
    universeGapGoldGroupCount: 0
  },
  {
    caseId: "a01",
    question: "简历检查从最初承诺、延期到最终交付的完整过程是什么？",
    scope: "all",
    category: "lifecycle",
    queryIntent: "full lifecycle sequence",
    goldGroups: [
      ["8745ced0-0eca-4b90-b674-7cc4d64865b8_chunk_00000_seg_00011"],
      [
        "ededf181-4b9b-4173-b23a-f9a306684764_chunk_00002_seg_00004",
        "ededf181-4b9b-4173-b23a-f9a306684764_chunk_00002_seg_00006",
        "ededf181-4b9b-4173-b23a-f9a306684764_chunk_00002_seg_00009"
      ],
      [
        "ce1b3268-0f9e-42f8-bc18-5b73c7660489_chunk_00007_seg_00019",
        "ce1b3268-0f9e-42f8-bc18-5b73c7660489_chunk_00008_seg_00002"
      ]
    ],
    baseline: {
      goldEvidenceId:
        "semantic_ededf181-4b9b-4173-b23a-f9a306684764_ededf181-4b9b-4173-b23a-f9a306684764_chunk_00001_seg_00018_ededf181-4b9b-4173-b23a-f9a306684764_chunk_00003_seg_00007",
      hybridRank: 1,
      optimizedRankingRank: 2,
      bestGoldRankAfterRanking: 2,
      failureReason: "relevant_evidence_rank_worsened",
      largestCompetitorFeature: "lifecycle"
    },
    expectedOrderingInvariants: [
      "preserve_relevant_hybrid_top5",
      "preserve_lifecycle_chain"
    ],
    universeGapGoldGroupCount: 1
  },
  {
    caseId: "a04",
    question: "博物馆计划从提出、改期到完成的完整生命周期是什么？",
    scope: "all",
    category: "lifecycle",
    queryIntent: "full lifecycle sequence",
    goldGroups: [
      ["be7b4039-b0a2-44aa-9c96-7807bed6a080_chunk_00001_seg_00001"],
      ["84626b28-b744-4bac-a6fb-09c07adbb730_chunk_00004_seg_00001"],
      [
        "a0b0656f-4036-4600-8c58-5fbb946a3bda_chunk_00008_seg_00009",
        "a0b0656f-4036-4600-8c58-5fbb946a3bda_chunk_00008_seg_00017"
      ]
    ],
    baseline: {
      goldEvidenceId:
        "semantic_be7b4039-b0a2-44aa-9c96-7807bed6a080_be7b4039-b0a2-44aa-9c96-7807bed6a080_chunk_00000_seg_00001_be7b4039-b0a2-44aa-9c96-7807bed6a080_chunk_00001_seg_00016",
      hybridRank: 1,
      optimizedRankingRank: 16,
      bestGoldRankAfterRanking: 2,
      failureReason: "relevant_evidence_rank_worsened",
      largestCompetitorFeature: "semantic"
    },
    expectedOrderingInvariants: [
      "preserve_relevant_hybrid_top5",
      "preserve_lifecycle_chain"
    ],
    universeGapGoldGroupCount: 0
  },
  {
    caseId: "a05",
    question: "博物馆计划为什么改变，决定改期而不是勉强成行的依据是什么？",
    scope: "all",
    category: "decision",
    queryIntent: "decision rationale",
    goldGroups: [
      ["84626b28-b744-4bac-a6fb-09c07adbb730_chunk_00004_seg_00001"],
      ["84626b28-b744-4bac-a6fb-09c07adbb730_chunk_00004_seg_00007"]
    ],
    baseline: {
      goldEvidenceId:
        "semantic_84626b28-b744-4bac-a6fb-09c07adbb730_84626b28-b744-4bac-a6fb-09c07adbb730_chunk_00003_seg_00010_84626b28-b744-4bac-a6fb-09c07adbb730_chunk_00005_seg_00002",
      hybridRank: 11,
      optimizedRankingRank: 18,
      bestGoldRankAfterRanking: 18,
      failureReason: "crossed_top_16_boundary",
      largestCompetitorFeature: "lexical"
    },
    expectedOrderingInvariants: ["preserve_relevant_hybrid_top16"],
    universeGapGoldGroupCount: 0
  },
  {
    caseId: "a09",
    question: "多日互动中反复出现的计划变更沟通边界是什么？",
    scope: "all",
    category: "relationship",
    queryIntent: "cross-day relationship communication boundary",
    goldGroups: [
      ["8745ced0-0eca-4b90-b674-7cc4d64865b8_chunk_00000_seg_00011"],
      [
        "ededf181-4b9b-4173-b23a-f9a306684764_chunk_00002_seg_00006",
        "ededf181-4b9b-4173-b23a-f9a306684764_chunk_00002_seg_00010"
      ],
      [
        "84626b28-b744-4bac-a6fb-09c07adbb730_chunk_00004_seg_00005",
        "84626b28-b744-4bac-a6fb-09c07adbb730_chunk_00004_seg_00006"
      ]
    ],
    baseline: {
      goldEvidenceId:
        "semantic_84626b28-b744-4bac-a6fb-09c07adbb730_84626b28-b744-4bac-a6fb-09c07adbb730_chunk_00003_seg_00010_84626b28-b744-4bac-a6fb-09c07adbb730_chunk_00005_seg_00002",
      hybridRank: 18,
      optimizedRankingRank: 35,
      bestGoldRankAfterRanking: 35,
      failureReason: "relevant_evidence_rank_worsened",
      largestCompetitorFeature: "semantic"
    },
    expectedOrderingInvariants: ["preserve_relevant_hybrid_top30"],
    universeGapGoldGroupCount: 1
  }
] as const;

export const PHASE_3_1_REGRESSION_CASE_IDS = new Set<RankingRegressionCaseId>(
  PHASE_3_1_RANKING_REGRESSIONS.map((item) => item.caseId)
);
