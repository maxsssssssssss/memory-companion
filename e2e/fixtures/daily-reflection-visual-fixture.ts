import type { Page, Route } from "@playwright/test";

import type {
  DailyReflectionCandidateView,
  DailyReflectionCardView,
  DailyReflectionDetailResponse,
  DailyReflectionHistoryResponse,
  DailyReflectionTranscriptSegmentView,
  DailyReflectionWorkingCardDetailResponse,
  DailyReflectionWorkingCardListResponse,
  DailyReflectionWorkingCardView
} from "@/lib/domain/daily-reflection-api";
import type { DailyReflectionMemoryRecommendationResponse } from "@/lib/domain/daily-reflection-memory-proposal";
import type {
  DailyReflectionMemoryDetailResponse,
  DailyReflectionMemoryListResponse,
  DailyReflectionMemoryView
} from "@/lib/domain/daily-reflection-memory-view";
import type {
  DailyReflectionDailyReturnResponse,
  DailyReflectionReturnEvidence,
  DailyReflectionReturnItem,
  DailyReflectionWeeklyItem,
  DailyReflectionWeeklyReflectionResponse
} from "@/lib/domain/daily-reflection-return";

export const DAILY_REFLECTION_VISUAL_FIXTURE_IDS = {
  accountId: "dr_visual_account",
  sessionReflectionId: "dr_visual_reflection_session",
  decisionReflectionId: "dr_visual_reflection_decision",
  preferenceReflectionId: "dr_visual_reflection_preference",
  uploadId: "dr_visual_upload_session",
  jobId: "dr_visual_job_session",
  insightCandidateId: "dr_visual_candidate_insight",
  questionCandidateId: "dr_visual_candidate_question",
  insightCardId: "dr_visual_card_insight",
  questionCardId: "dr_visual_card_question",
  decisionCardId: "dr_visual_card_decision",
  preferenceCardId: "dr_visual_card_preference",
  insightSegmentId: "dr_visual_segment_insight",
  questionSegmentId: "dr_visual_segment_question",
  decisionSegmentId: "dr_visual_segment_decision",
  preferenceSegmentId: "dr_visual_segment_preference",
  decisionMemoryId: "dr_visual_memory_decision",
  preferenceMemoryId: "dr_visual_memory_preference"
} as const;

export type DailyReflectionVisualFixtureMode = "populated" | "empty";

export type DailyReflectionVisualAuthResponse = {
  user: {
    id: string;
    email: string;
    name: string;
  };
};

export type DailyReflectionVisualFixture = {
  mode: DailyReflectionVisualFixtureMode;
  ids: typeof DAILY_REFLECTION_VISUAL_FIXTURE_IDS;
  auth: DailyReflectionVisualAuthResponse;
  history: DailyReflectionHistoryResponse;
  detail: DailyReflectionDetailResponse;
  recommendations: DailyReflectionMemoryRecommendationResponse;
  cardList: DailyReflectionWorkingCardListResponse;
  cardDetail: DailyReflectionWorkingCardDetailResponse;
  memoryList: DailyReflectionMemoryListResponse;
  memoryDetail: DailyReflectionMemoryDetailResponse;
  dailyReturn: DailyReflectionDailyReturnResponse;
  weeklyReturn: DailyReflectionWeeklyReflectionResponse;
};

export type DailyReflectionVisualRouteResolution =
  | {
    action: "continue";
    method: string;
    pathname: string;
    status: null;
  }
  | {
    action: "fulfill";
    body: unknown;
    method: string;
    pathname: string;
    status: 200 | 500;
  };

export type DailyReflectionVisualRequestRecord = Pick<
  DailyReflectionVisualRouteResolution,
  "action" | "method" | "pathname" | "status"
>;

export type DailyReflectionVisualFixtureController = {
  fixture: DailyReflectionVisualFixture;
  requests: DailyReflectionVisualRequestRecord[];
};

const CREATED_AT = "2026-08-24T01:00:00.000Z";
const UPDATED_AT = "2026-08-24T01:08:00.000Z";
const SESSION_DATE = "2026-08-24";
const DECISION_DATE = "2026-08-23";
const PREFERENCE_DATE = "2026-08-21";
const JSON_HEADERS = {
  "Cache-Control": "private, no-store"
} as const;

function buildSegments(): DailyReflectionTranscriptSegmentView[] {
  return [{
    id: DAILY_REFLECTION_VISUAL_FIXTURE_IDS.insightSegmentId,
    uploadId: DAILY_REFLECTION_VISUAL_FIXTURE_IDS.uploadId,
    startSeconds: 8,
    endSeconds: 16,
    speaker: "我",
    text: "散步以后，我发现先把最小版本做完整，更容易看清下一步。",
    confidence: 0.98,
    sceneLabels: [],
    valueLabels: []
  }, {
    id: DAILY_REFLECTION_VISUAL_FIXTURE_IDS.questionSegmentId,
    uploadId: DAILY_REFLECTION_VISUAL_FIXTURE_IDS.uploadId,
    startSeconds: 24,
    endSeconds: 33,
    speaker: "我",
    text: "我还想继续想清楚，什么时候应该扩展范围。",
    confidence: 0.97,
    sceneLabels: [],
    valueLabels: []
  }];
}

function candidateEvidence(segment: DailyReflectionTranscriptSegmentView) {
  return {
    sourceSegmentId: segment.id,
    uploadId: segment.uploadId,
    effectiveOrigin: "user_reflection" as const,
    startSeconds: segment.startSeconds,
    endSeconds: segment.endSeconds,
    text: segment.text
  };
}

function buildCandidates(
  segments: DailyReflectionTranscriptSegmentView[]
): DailyReflectionCandidateView[] {
  const [insightSegment, questionSegment] = segments;
  return [{
    id: DAILY_REFLECTION_VISUAL_FIXTURE_IDS.insightCandidateId,
    reflectionId: DAILY_REFLECTION_VISUAL_FIXTURE_IDS.sessionReflectionId,
    ordinal: 0,
    proposedText: "先完成可验证的小版本，再决定是否扩大范围。",
    userText: null,
    status: "kept",
    candidateType: "summary",
    sourceSegmentIds: [insightSegment.id],
    subjectPersonId: null,
    subjectConfirmed: false,
    version: 1,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    evidence: [candidateEvidence(insightSegment)]
  }, {
    id: DAILY_REFLECTION_VISUAL_FIXTURE_IDS.questionCandidateId,
    reflectionId: DAILY_REFLECTION_VISUAL_FIXTURE_IDS.sessionReflectionId,
    ordinal: 1,
    proposedText: "什么时候应该扩展当前工作的范围？",
    userText: null,
    status: "kept",
    candidateType: "question",
    sourceSegmentIds: [questionSegment.id],
    subjectPersonId: null,
    subjectConfirmed: false,
    version: 1,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    evidence: [candidateEvidence(questionSegment)]
  }];
}

function reflectionCard(
  input: {
    id: string;
    candidateId: string;
    kind: "insight" | "open_question";
    title: string;
    content: string;
    segment: DailyReflectionTranscriptSegmentView;
    rank: number;
  }
): DailyReflectionCardView {
  return {
    id: input.id,
    reflectionId: DAILY_REFLECTION_VISUAL_FIXTURE_IDS.sessionReflectionId,
    cardKind: input.kind,
    proposedTitle: input.title,
    proposedText: input.content,
    userTitle: null,
    userText: null,
    sourceCandidateIds: [input.candidateId],
    evidenceIds: [input.segment.id],
    clusterId: input.kind === "insight" ? "dr_visual_cluster_scope" : "dr_visual_cluster_question",
    clusterTitle: input.kind === "insight" ? "范围与节奏" : "继续思考",
    displayTier: "primary",
    rank: input.rank,
    confidence: 0.94,
    importance: input.kind === "insight" ? 0.88 : 0.76,
    durability: input.kind === "insight" ? 0.82 : 0.73,
    novelty: 0.68,
    epistemicStatus: "explicit_user_statement",
    riskFlags: [],
    actionClaimed: false,
    reviewStatus: "kept",
    version: 1,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    evidence: [candidateEvidence(input.segment)]
  };
}

function workingCard(input: {
  id: string;
  reflectionId: string;
  title: string;
  content: string;
  kind: DailyReflectionWorkingCardView["cardKind"];
  segmentId: string;
  tags: string[];
  lifecycle?: DailyReflectionWorkingCardView["memoryLifecycleStatus"];
  lifecycleVersion?: number;
}): DailyReflectionWorkingCardView {
  const lifecycle = input.lifecycle ?? "not_admitted";
  return {
    id: input.id,
    sourceReflectionIds: [input.reflectionId],
    title: input.title,
    content: input.content,
    cardKind: input.kind,
    evidenceIds: [input.segmentId],
    status: "saved",
    importance: 0.82,
    novelty: 0.7,
    relatedCardIds: [],
    tags: input.tags,
    visibility: "private",
    sourceUnavailable: false,
    memoryLifecycleStatus: lifecycle,
    memoryLifecycleVersion: input.lifecycleVersion ?? 0,
    memoryLifecycleUpdatedAt: lifecycle === "active" ? UPDATED_AT : null,
    version: 2,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT
  };
}

function buildSessionCards(
  segments: DailyReflectionTranscriptSegmentView[]
): [DailyReflectionCardView, DailyReflectionCardView] {
  const [insightSegment, questionSegment] = segments;
  return [reflectionCard({
    id: DAILY_REFLECTION_VISUAL_FIXTURE_IDS.insightCardId,
    candidateId: DAILY_REFLECTION_VISUAL_FIXTURE_IDS.insightCandidateId,
    kind: "insight",
    title: "先完成一个可验证的小版本",
    content: "先完成可验证的小版本，再决定是否扩大范围。",
    segment: insightSegment,
    rank: 0
  }), reflectionCard({
    id: DAILY_REFLECTION_VISUAL_FIXTURE_IDS.questionCardId,
    candidateId: DAILY_REFLECTION_VISUAL_FIXTURE_IDS.questionCandidateId,
    kind: "open_question",
    title: "什么时候应该扩展范围？",
    content: "继续观察扩展范围的判断条件。",
    segment: questionSegment,
    rank: 1
  })];
}

function buildDetail(): DailyReflectionDetailResponse {
  const segments = buildSegments();
  const cards = buildSessionCards(segments);
  return {
    reflection: {
      id: DAILY_REFLECTION_VISUAL_FIXTURE_IDS.sessionReflectionId,
      accountId: DAILY_REFLECTION_VISUAL_FIXTURE_IDS.accountId,
      uploadId: DAILY_REFLECTION_VISUAL_FIXTURE_IDS.uploadId,
      inputMethod: "file_upload",
      sourceOrigin: "user_reflection",
      processingProfile: "full_recording",
      ingestionContext: "daily_reflection",
      status: "review_pending",
      version: 4,
      idempotencyKey: "dr-visual-session-once",
      errorCode: null,
      errorMessage: null,
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT
    },
    processingPlan: {
      planVersion: 1,
      reflectionId: DAILY_REFLECTION_VISUAL_FIXTURE_IDS.sessionReflectionId,
      uploadId: DAILY_REFLECTION_VISUAL_FIXTURE_IDS.uploadId,
      inputMethod: "file_upload",
      sourceOrigin: "user_reflection",
      processingProfile: "full_recording",
      ingestionContext: "daily_reflection",
      reviewPolicy: "required"
    },
    job: {
      id: DAILY_REFLECTION_VISUAL_FIXTURE_IDS.jobId,
      reflectionId: DAILY_REFLECTION_VISUAL_FIXTURE_IDS.sessionReflectionId,
      uploadId: DAILY_REFLECTION_VISUAL_FIXTURE_IDS.uploadId,
      status: "completed",
      progress: 100,
      executionMode: "inline",
      updatedAt: UPDATED_AT,
      finishedAt: UPDATED_AT
    },
    upload: {
      id: DAILY_REFLECTION_VISUAL_FIXTURE_IDS.uploadId,
      originalName: "周日散步.m4a",
      mimeType: "audio/mp4",
      sizeBytes: 4_096,
      recordingDate: SESSION_DATE,
      durationSeconds: 48,
      status: "ready"
    },
    segments,
    effectiveOrigin: "user_reflection",
    candidates: buildCandidates(segments),
    cards,
    workingCards: cards.map((card) => ({
      id: card.id,
      status: "saved" as const,
      memoryLifecycleStatus: "not_admitted" as const,
      version: 2
    })),
    confirmation: null,
    admissionOperation: null,
    admissionResults: []
  };
}

function buildHistory(): DailyReflectionHistoryResponse {
  return {
    reflections: [{
      id: DAILY_REFLECTION_VISUAL_FIXTURE_IDS.sessionReflectionId,
      status: "review_pending",
      inputMethod: "file_upload",
      sourceOrigin: "user_reflection",
      recordingDate: SESSION_DATE,
      sourceStatement: "来自 8 月 24 日的个人复盘",
      candidateCount: 2,
      pendingCount: 0,
      keptCount: 2,
      excludedCount: 0,
      rememberedCount: 0,
      notSavedCount: 0,
      subjectPersonIds: [],
      transcriptAvailable: true,
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT
    }, {
      id: DAILY_REFLECTION_VISUAL_FIXTURE_IDS.decisionReflectionId,
      status: "completed",
      inputMethod: "browser_recording",
      sourceOrigin: "user_reflection",
      recordingDate: DECISION_DATE,
      sourceStatement: "来自 8 月 23 日的个人复盘",
      candidateCount: 1,
      pendingCount: 0,
      keptCount: 1,
      excludedCount: 0,
      rememberedCount: 1,
      notSavedCount: 0,
      subjectPersonIds: [],
      transcriptAvailable: true,
      createdAt: "2026-08-23T02:00:00.000Z",
      updatedAt: "2026-08-23T02:06:00.000Z"
    }, {
      id: DAILY_REFLECTION_VISUAL_FIXTURE_IDS.preferenceReflectionId,
      status: "completed",
      inputMethod: "browser_recording",
      sourceOrigin: "user_reflection",
      recordingDate: PREFERENCE_DATE,
      sourceStatement: "来自 8 月 21 日的个人复盘",
      candidateCount: 1,
      pendingCount: 0,
      keptCount: 1,
      excludedCount: 0,
      rememberedCount: 1,
      notSavedCount: 0,
      subjectPersonIds: [],
      transcriptAvailable: true,
      createdAt: "2026-08-21T02:00:00.000Z",
      updatedAt: "2026-08-21T02:05:00.000Z"
    }]
  };
}

function buildWorkingCards(): DailyReflectionWorkingCardView[] {
  return [workingCard({
    id: DAILY_REFLECTION_VISUAL_FIXTURE_IDS.insightCardId,
    reflectionId: DAILY_REFLECTION_VISUAL_FIXTURE_IDS.sessionReflectionId,
    title: "先完成一个可验证的小版本",
    content: "先完成可验证的小版本，再决定是否扩大范围。",
    kind: "insight",
    segmentId: DAILY_REFLECTION_VISUAL_FIXTURE_IDS.insightSegmentId,
    tags: ["节奏", "范围"]
  }), workingCard({
    id: DAILY_REFLECTION_VISUAL_FIXTURE_IDS.questionCardId,
    reflectionId: DAILY_REFLECTION_VISUAL_FIXTURE_IDS.sessionReflectionId,
    title: "什么时候应该扩展范围？",
    content: "继续观察扩展范围的判断条件。",
    kind: "question",
    segmentId: DAILY_REFLECTION_VISUAL_FIXTURE_IDS.questionSegmentId,
    tags: ["开放问题"]
  }), workingCard({
    id: DAILY_REFLECTION_VISUAL_FIXTURE_IDS.decisionCardId,
    reflectionId: DAILY_REFLECTION_VISUAL_FIXTURE_IDS.decisionReflectionId,
    title: "先完成桌面端原型",
    content: "先把桌面端原型完成，再决定是否扩展到其他载体。",
    kind: "decision",
    segmentId: DAILY_REFLECTION_VISUAL_FIXTURE_IDS.decisionSegmentId,
    tags: ["产品", "决定"],
    lifecycle: "active",
    lifecycleVersion: 3
  }), workingCard({
    id: DAILY_REFLECTION_VISUAL_FIXTURE_IDS.preferenceCardId,
    reflectionId: DAILY_REFLECTION_VISUAL_FIXTURE_IDS.preferenceReflectionId,
    title: "先看重点，再展开细节",
    content: "我更喜欢先看最重要的内容，再按需要回到完整记录。",
    kind: "insight",
    segmentId: DAILY_REFLECTION_VISUAL_FIXTURE_IDS.preferenceSegmentId,
    tags: ["阅读", "偏好"],
    lifecycle: "active",
    lifecycleVersion: 2
  })];
}

function buildCardDetail(
  card: DailyReflectionWorkingCardView
): DailyReflectionWorkingCardDetailResponse {
  return {
    card: {
      ...card,
      evidence: [{
        sourceSegmentId: DAILY_REFLECTION_VISUAL_FIXTURE_IDS.insightSegmentId,
        uploadId: DAILY_REFLECTION_VISUAL_FIXTURE_IDS.uploadId,
        effectiveOrigin: "user_reflection",
        startSeconds: 8,
        endSeconds: 16,
        text: "散步以后，我发现先把最小版本做完整，更容易看清下一步。"
      }]
    }
  };
}

function memoryEvidence(input: {
  reflectionId: string;
  cardId: string;
  recordingDate: string;
  segmentId: string;
  snippet: string;
  startSeconds: number;
}): DailyReflectionReturnEvidence {
  return {
    reflectionId: input.reflectionId,
    cardId: input.cardId,
    recordingDate: input.recordingDate,
    sourceOrigin: "user_reflection",
    sourceSegmentId: input.segmentId,
    startSeconds: input.startSeconds,
    endSeconds: input.startSeconds + 8,
    snippet: input.snippet
  };
}

function buildMemories(): DailyReflectionMemoryView[] {
  return [{
    id: DAILY_REFLECTION_VISUAL_FIXTURE_IDS.decisionMemoryId,
    cardId: DAILY_REFLECTION_VISUAL_FIXTURE_IDS.decisionCardId,
    reflectionId: DAILY_REFLECTION_VISUAL_FIXTURE_IDS.decisionReflectionId,
    recordingDate: DECISION_DATE,
    memoryType: "decision",
    cardKind: "decision",
    epistemicStatus: "explicit_user_statement",
    epistemicCaution: null,
    title: "先完成桌面端原型",
    content: "先把桌面端原型完成，再决定是否扩展到其他载体。",
    sourceCount: 1,
    evidence: [memoryEvidence({
      reflectionId: DAILY_REFLECTION_VISUAL_FIXTURE_IDS.decisionReflectionId,
      cardId: DAILY_REFLECTION_VISUAL_FIXTURE_IDS.decisionCardId,
      recordingDate: DECISION_DATE,
      segmentId: DAILY_REFLECTION_VISUAL_FIXTURE_IDS.decisionSegmentId,
      snippet: "我决定先完成桌面端原型。",
      startSeconds: 12
    })]
  }, {
    id: DAILY_REFLECTION_VISUAL_FIXTURE_IDS.preferenceMemoryId,
    cardId: DAILY_REFLECTION_VISUAL_FIXTURE_IDS.preferenceCardId,
    reflectionId: DAILY_REFLECTION_VISUAL_FIXTURE_IDS.preferenceReflectionId,
    recordingDate: PREFERENCE_DATE,
    memoryType: "preference",
    cardKind: "insight",
    epistemicStatus: "explicit_user_statement",
    epistemicCaution: null,
    title: "先看重点，再展开细节",
    content: "我更喜欢先看最重要的内容，再按需要回到完整记录。",
    sourceCount: 1,
    evidence: [memoryEvidence({
      reflectionId: DAILY_REFLECTION_VISUAL_FIXTURE_IDS.preferenceReflectionId,
      cardId: DAILY_REFLECTION_VISUAL_FIXTURE_IDS.preferenceCardId,
      recordingDate: PREFERENCE_DATE,
      segmentId: DAILY_REFLECTION_VISUAL_FIXTURE_IDS.preferenceSegmentId,
      snippet: "我更喜欢先看最重要的内容。",
      startSeconds: 20
    })]
  }];
}

function dailyItem(input: {
  id: string;
  type: DailyReflectionReturnItem["type"];
  title: string;
  body: string;
  memory: DailyReflectionMemoryView;
}): DailyReflectionReturnItem {
  return {
    id: input.id,
    type: input.type,
    title: input.title,
    body: input.body,
    sourceMemoryIds: [input.memory.id],
    sourceCardIds: [input.memory.cardId],
    evidenceIds: input.memory.evidence.map((item) => item.sourceSegmentId),
    evidence: input.memory.evidence,
    epistemicStatuses: [input.memory.epistemicStatus],
    createdAt: UPDATED_AT
  };
}

function weeklyItem(input: {
  id: string;
  type: DailyReflectionWeeklyItem["type"];
  title: string;
  body: string;
  memories: DailyReflectionMemoryView[];
  dates: string[];
}): DailyReflectionWeeklyItem {
  const evidence = input.memories.flatMap((memory) => memory.evidence);
  return {
    id: input.id,
    type: input.type,
    title: input.title,
    body: input.body,
    sourceCount: input.type === "repeated_theme" ? Math.max(2, input.memories.length) : 1,
    dates: input.dates,
    sourceMemoryIds: input.type === "emerging_idea" ? [] : input.memories.map((memory) => memory.id),
    sourceCardIds: input.memories.map((memory) => memory.cardId),
    evidenceIds: evidence.map((item) => item.sourceSegmentId),
    evidence,
    epistemicStatuses: ["explicit_user_statement"],
    createdAt: UPDATED_AT
  };
}

function buildDailyReturn(memories: DailyReflectionMemoryView[]): DailyReflectionDailyReturnResponse {
  const [decision, preference] = memories;
  return {
    referenceDate: SESSION_DATE,
    timeZone: "Asia/Shanghai",
    openLoops: [dailyItem({
      id: "dr_visual_return_open_loop",
      type: "open_loop",
      title: "确认原型范围",
      body: "桌面端原型的范围还需要继续确认。",
      memory: decision
    })],
    resurfacedMemories: [dailyItem({
      id: "dr_visual_return_resurfaced",
      type: "resurfaced_memory",
      title: "先看重点，再展开",
      body: "之前明确表达过先看重点、再展开细节的偏好。",
      memory: preference
    })],
    reflectionPrompts: [dailyItem({
      id: "dr_visual_return_prompt",
      type: "reflection_prompt",
      title: "范围判断有变化吗？",
      body: "你之前决定先完成桌面端原型，现在这个判断有变化吗？",
      memory: decision
    })]
  };
}

function buildWeeklyReturn(
  memories: DailyReflectionMemoryView[]
): DailyReflectionWeeklyReflectionResponse {
  const [decision, preference] = memories;
  return {
    startDate: "2026-08-18",
    endDate: SESSION_DATE,
    timeZone: "Asia/Shanghai",
    repeatedThemes: [weeklyItem({
      id: "dr_visual_weekly_theme",
      type: "repeated_theme",
      title: "先收窄范围，再继续扩展",
      body: "两次复盘都提到先看清重点，再决定下一步。",
      memories: [decision, preference],
      dates: [PREFERENCE_DATE, DECISION_DATE]
    })],
    changedDecisions: [weeklyItem({
      id: "dr_visual_weekly_decision",
      type: "changed_decision",
      title: "载体范围逐渐收敛",
      body: "当前决定从同时探索多个载体，收敛为先完成桌面端原型。",
      memories: [decision],
      dates: [DECISION_DATE]
    })],
    openCommitments: [weeklyItem({
      id: "dr_visual_weekly_commitment",
      type: "open_commitment",
      title: "完成可验证原型",
      body: "完成可验证的小版本仍是当前尚未结束的事项。",
      memories: [decision],
      dates: [DECISION_DATE]
    })],
    emergingIdeas: [weeklyItem({
      id: "dr_visual_weekly_idea",
      type: "emerging_idea",
      title: "把范围判断写成清单",
      body: "可以把扩大范围前需要满足的条件写成可核对清单。",
      memories: [preference],
      dates: [PREFERENCE_DATE]
    })]
  };
}

function buildPopulatedFixture(): DailyReflectionVisualFixture {
  const detail = buildDetail();
  const cards = buildWorkingCards();
  const memories = buildMemories();
  return {
    mode: "populated",
    ids: DAILY_REFLECTION_VISUAL_FIXTURE_IDS,
    auth: {
      user: {
        id: DAILY_REFLECTION_VISUAL_FIXTURE_IDS.accountId,
        email: "daily-reflection-visual@example.com",
        name: "视觉复盘用户"
      }
    },
    history: buildHistory(),
    detail,
    recommendations: {
      reflectionId: DAILY_REFLECTION_VISUAL_FIXTURE_IDS.sessionReflectionId,
      policyVersion: "daily_reflection_memory_recommendation_v1",
      recommendationFingerprint: "a".repeat(64),
      maxRecommendations: 5,
      eligibleCount: 2,
      recommendations: [{
        cardId: DAILY_REFLECTION_VISUAL_FIXTURE_IDS.insightCardId,
        memoryType: "summary",
        rank: 1,
        score: 0.92,
        clusterId: "dr_visual_cluster_scope",
        sourceOrigin: "user_reflection",
        reasons: ["saved_working_card"],
        defaultSelected: false
      }, {
        cardId: DAILY_REFLECTION_VISUAL_FIXTURE_IDS.questionCardId,
        memoryType: "question",
        rank: 2,
        score: 0.84,
        clusterId: "dr_visual_cluster_question",
        sourceOrigin: "user_reflection",
        reasons: ["open_question_with_evidence"],
        defaultSelected: false
      }]
    },
    cardList: {
      cards,
      total: cards.length,
      limit: 50,
      offset: 0
    },
    cardDetail: buildCardDetail(cards[0]),
    memoryList: {
      memories,
      total: memories.length
    },
    memoryDetail: {
      memory: memories[0]
    },
    dailyReturn: buildDailyReturn(memories),
    weeklyReturn: buildWeeklyReturn(memories)
  };
}

/**
 * `empty` keeps detail DTOs available for direct detail-route screenshots while
 * returning valid empty collections for History, Cards, Memory, recommendations,
 * and Today/Weekly return surfaces.
 */
export function createDailyReflectionVisualFixture(
  mode: DailyReflectionVisualFixtureMode = "populated"
): DailyReflectionVisualFixture {
  const populated = buildPopulatedFixture();
  if (mode === "populated") return populated;
  return {
    ...populated,
    mode,
    history: { reflections: [] },
    recommendations: {
      ...populated.recommendations,
      eligibleCount: 0,
      recommendations: []
    },
    cardList: {
      cards: [],
      total: 0,
      limit: populated.cardList.limit,
      offset: populated.cardList.offset
    },
    memoryList: { memories: [], total: 0 },
    dailyReturn: {
      ...populated.dailyReturn,
      openLoops: [],
      resurfacedMemories: [],
      reflectionPrompts: []
    },
    weeklyReturn: {
      ...populated.weeklyReturn,
      repeatedThemes: [],
      changedDecisions: [],
      openCommitments: [],
      emergingIdeas: []
    }
  };
}

function fixtureRoutes(fixture: DailyReflectionVisualFixture): Map<string, unknown> {
  const ids = fixture.ids;
  return new Map<string, unknown>([
    ["GET /api/auth/me", fixture.auth],
    ["GET /api/daily-reflections", fixture.history],
    [`GET /api/daily-reflections/${ids.sessionReflectionId}`, fixture.detail],
    [
      `GET /api/daily-reflections/${ids.sessionReflectionId}/memory-recommendations`,
      fixture.recommendations
    ],
    ["GET /api/daily-reflections/cards", fixture.cardList],
    [`GET /api/daily-reflections/cards/${ids.insightCardId}`, fixture.cardDetail],
    ["GET /api/daily-reflections/memories", fixture.memoryList],
    [`GET /api/daily-reflections/memories/${ids.decisionMemoryId}`, fixture.memoryDetail],
    ["GET /api/daily-reflections/returns/daily", fixture.dailyReturn],
    ["GET /api/daily-reflections/returns/weekly", fixture.weeklyReturn]
  ]);
}

function isFixtureOwnedPath(pathname: string): boolean {
  return pathname === "/api/auth/me"
    || pathname === "/api/daily-reflections"
    || pathname.startsWith("/api/daily-reflections/");
}

export function resolveDailyReflectionVisualRequest(
  fixture: DailyReflectionVisualFixture,
  method: string,
  requestUrl: string | URL
): DailyReflectionVisualRouteResolution {
  const normalizedMethod = method.toUpperCase();
  const pathname = new URL(requestUrl, "http://daily-brief.visual.invalid").pathname;
  const body = fixtureRoutes(fixture).get(`${normalizedMethod} ${pathname}`);
  if (body !== undefined) {
    return {
      action: "fulfill",
      body,
      method: normalizedMethod,
      pathname,
      status: 200
    };
  }
  if (isFixtureOwnedPath(pathname)) {
    return {
      action: "fulfill",
      body: {
        error: "daily_reflection_visual_fixture_unhandled_request",
        fixtureMode: fixture.mode,
        method: normalizedMethod,
        pathname
      },
      method: normalizedMethod,
      pathname,
      status: 500
    };
  }
  return {
    action: "continue",
    method: normalizedMethod,
    pathname,
    status: null
  };
}

export async function installDailyReflectionVisualFixture(
  page: Page,
  options: {
    mode?: DailyReflectionVisualFixtureMode;
    onRequest?: (record: DailyReflectionVisualRequestRecord) => void;
  } = {}
): Promise<DailyReflectionVisualFixtureController> {
  const fixture = createDailyReflectionVisualFixture(options.mode);
  const requests: DailyReflectionVisualRequestRecord[] = [];
  await page.route("**/api/**", async (route: Route) => {
    const request = route.request();
    const resolution = resolveDailyReflectionVisualRequest(
      fixture,
      request.method(),
      request.url()
    );
    const record: DailyReflectionVisualRequestRecord = {
      action: resolution.action,
      method: resolution.method,
      pathname: resolution.pathname,
      status: resolution.status
    };
    requests.push(record);
    options.onRequest?.(record);
    if (resolution.action === "continue") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: resolution.status,
      contentType: "application/json",
      headers: JSON_HEADERS,
      body: JSON.stringify(resolution.body)
    });
  });
  return { fixture, requests };
}
