import { randomUUID } from "node:crypto";
import { z } from "zod";

import {
  AudioUploadSchema,
  type QuestionAnswer,
  TranscriptSegmentSchema,
  type TranscriptSegment
} from "@/lib/domain/types";
import {
  answerQuestionStream,
  answerQuestionWithAI,
  type AnswerQuestionStreamInput,
  type AnswerQuestionWithAIInput,
  type QaConversationMessage
} from "@/lib/server/retrieval/ai-qa";
import {
  createQaStreamingTraceRecorder,
  type QaAnswerStreamEvent
} from "@/lib/server/retrieval/qa-streaming";
import type { JsonStore } from "@/lib/server/storage/json-store";
import {
  personQaEvidenceKey,
  type TrustedPersonQaEvidenceResolver
} from "./person-relationship-qa-evidence-resolver";
import type { RelationshipContextChange } from "./relationship-context";
import type {
  PersonCommitment,
  PersonEntity,
  PersonEvidence,
  PersonFact
} from "./types";

type EvidenceBearingRelationship = {
  evidence: PersonEvidence[];
};

export type PersonRelationshipQaSourceContext = {
  known: boolean;
  asOf: string;
  person: Pick<PersonEntity, "id" | "accountId"> | null;
  confirmedRelationships: EvidenceBearingRelationship[];
  recentFacts: PersonFact[];
  activeFacts: PersonFact[];
  previousFacts: PersonFact[];
  recentChanges: RelationshipContextChange[];
  activeCommitments: PersonCommitment[];
  completedCommitments: PersonCommitment[];
};

export type PersonRelationshipQaContext = {
  segments: TranscriptSegment[];
  eligibleSourceSegmentIds: string[];
  blockedByUnavailableSelfRole: boolean;
  activeSelfPersonId: string | null;
};

type EvidenceIntent = "all" | "changes" | "commitments";

const PERSON_QA_PROMPT_INSTRUCTION = [
  "这是显式 personId 限定的 Person-scoped Relationship QA。",
  "只能根据服务端提供的该 Person 范围内真实 Transcript Evidence 回答；Person profile、显示名、别名、Fact derivedText、Commitment 派生说明和 Relationship 标签都不是事实来源。",
  "不得把账号用户、所选 Person 或录音中的说话人猜成‘我’、‘你’或‘Ta’。没有明确的 self Person 映射时，不得生成‘你答应了’、‘Ta 答应了’之类角色归属；证据不能明确角色时返回 unsupported。",
  "承诺只能陈述原始证据中明确出现的 promisor 和 promisee，最近变化只能陈述所提供 transition 证据支持的变化。"
].join("\n");
const SAFE_UNCERTAINTY_ANSWER = "没有找到足够证据确认这个信息。";

export function personRelationshipQaSafeUncertaintyAnswer(
  input: Pick<AnswerQuestionWithAIInput, "uploadId" | "question">
): QuestionAnswer {
  return {
    id: randomUUID(),
    uploadId: input.uploadId,
    question: input.question,
    answer: SAFE_UNCERTAINTY_ANSWER,
    citedSegmentIds: [],
    citations: [],
    createdAt: new Date().toISOString()
  };
}

/**
 * Person QA requires no-Evidence assistant-meta questions to fail closed too.
 * The shared browser projection still owns NDJSON meta/final/complete events.
 */
export async function* personRelationshipQaSafeUncertaintyStream(
  input: AnswerQuestionStreamInput
): AsyncGenerator<QaAnswerStreamEvent> {
  const recorder = createQaStreamingTraceRecorder();
  yield {
    type: "stream_started",
    streamId: recorder.streamId,
    timestamp: recorder.startedAt
  };
  const trace = recorder.complete({
    status: "completed_with_fallback",
    tokenChunkCount: 0,
    sentenceCount: 0,
    providerCallCount: 0,
    fallbackReason: "insufficient_evidence"
  });
  yield {
    type: "final",
    answer: personRelationshipQaSafeUncertaintyAnswer(input),
    source: "non_stream_fallback",
    trace
  };
}

function containsUnavailablePersonRoleProjection(value: string) {
  const pronoun = "(?:我|你|他|她|自己|\\b(?:ta|i|me|my|you|your|he|she)\\b)";
  const factualRole = [
    "喜欢", "偏好", "讨厌", "不喜欢", "住", "居住", "在", "拥有", "有",
    "答应", "承诺", "许诺", "保证", "负责", "完成", "认识", "属于",
    "prefer(?:s|red)?", "like(?:s|d)?", "live(?:s|d)?", "promise(?:s|d)?",
    "commit(?:s|ted)?", "own(?:s|ed)?", "complete(?:s|d)?"
  ].join("|");
  return new RegExp(`${pronoun}.{0,16}(?:${factualRole})`, "iu").test(value) ||
    new RegExp(`(?:${factualRole}).{0,16}(?:给|向|对)?${pronoun}`, "iu").test(value);
}

function personRelationshipQaAnswerIsSafe(
  answer: QuestionAnswer,
  eligibleSourceSegmentIds: readonly string[]
) {
  if (
    answer.answer === SAFE_UNCERTAINTY_ANSWER &&
    answer.citedSegmentIds.length === 0 &&
    (answer.citations?.length ?? 0) === 0
  ) {
    return true;
  }
  const eligible = new Set(eligibleSourceSegmentIds);
  const citations = answer.citations ?? [];
  if (
    citations.length === 0 ||
    answer.citedSegmentIds.length === 0 ||
    answer.citedSegmentIds.some((sourceId) => !eligible.has(sourceId)) ||
    citations.some((citation) =>
      citation.sourceSegmentIds.some((sourceId) => !eligible.has(sourceId))
    ) ||
    containsUnavailablePersonRoleProjection(answer.answer)
  ) {
    return false;
  }
  return true;
}

export async function answerPersonRelationshipQuestion(
  input: AnswerQuestionWithAIInput,
  eligibleSourceSegmentIds: readonly string[],
  dependencies: {
    answerQuestion?: typeof answerQuestionWithAI;
  } = {}
) {
  const answer = await (dependencies.answerQuestion ?? answerQuestionWithAI)(input);
  return personRelationshipQaAnswerIsSafe(answer, eligibleSourceSegmentIds)
    ? answer
    : personRelationshipQaSafeUncertaintyAnswer(input);
}

export async function* answerPersonRelationshipQuestionStream(
  input: AnswerQuestionStreamInput,
  eligibleSourceSegmentIds: readonly string[],
  dependencies: {
    answerQuestionStream?: typeof answerQuestionStream;
  } = {}
): AsyncGenerator<QaAnswerStreamEvent> {
  const eligible = new Set(eligibleSourceSegmentIds);
  const stream = dependencies.answerQuestionStream ?? answerQuestionStream;
  for await (const event of stream(input)) {
    if (event.type === "sentence_completed") {
      if (
        event.supportIds.some((sourceId) => !eligible.has(sourceId)) ||
        event.citedSegmentIds.some((sourceId) => !eligible.has(sourceId)) ||
        containsUnavailablePersonRoleProjection(event.sentence)
      ) {
        continue;
      }
      yield event;
      continue;
    }
    if (
      event.type === "final" &&
      !personRelationshipQaAnswerIsSafe(event.answer, eligibleSourceSegmentIds)
    ) {
      yield {
        type: "final",
        answer: personRelationshipQaSafeUncertaintyAnswer(input),
        source: "provider_stream_validation_fallback",
        trace: {
          ...event.trace,
          status: "completed_with_fallback",
          fallbackReason: "relationship_scope_boundary"
        }
      };
      continue;
    }
    yield event;
  }
}

function contextualQuestion(
  question: string,
  conversation: readonly QaConversationMessage[]
) {
  return [
    ...conversation
      .filter((message) => message.role === "user")
      .slice(-2)
      .map((message) => message.content),
    question
  ].join("\n");
}

function evidenceIntent(
  question: string,
  conversation: readonly QaConversationMessage[]
): EvidenceIntent {
  const context = contextualQuestion(question, conversation);
  if (
    /最近.{0,12}(?:变化|改变|更新)|(?:变化|改变|更新).{0,12}最近|现在.{0,16}(?:之前|过去|原来)|(?:之前|过去|原来).{0,16}现在|recent.{0,16}(?:change|update)/iu
      .test(context)
  ) {
    return "changes";
  }
  if (/答应|承诺|许诺|保证|promise|commitment/iu.test(context)) {
    return "commitments";
  }
  return "all";
}

export function requiresUnavailableSelfPersonMapping(
  question: string,
  conversation: readonly QaConversationMessage[]
) {
  const context = contextualQuestion(question, conversation);
  if (!/答应|承诺|许诺|保证|promise|commit/iu.test(context)) return false;

  const currentQuestion = question.normalize("NFKC");
  const selfPronoun = "(?:我|你|他|她|自己|\\b(?:ta|i|me|my|you|your)\\b)";
  const commitment = "(?:答应|承诺|许诺|保证|promise(?:d)?|commit(?:ted|ment)?)";
  return new RegExp(`${selfPronoun}.{0,12}${commitment}`, "iu").test(currentQuestion) ||
    new RegExp(`${commitment}.{0,12}(?:给|向|对)?${selfPronoun}`, "iu").test(currentQuestion) ||
    (/^(?:那|那么)?\s*(?:我|你|Ta|TA|ta|他|她)(?:呢|的)?[？?]?$/u.test(currentQuestion.trim()) &&
      /答应|承诺|许诺|保证|promise|commit/iu.test(context));
}

function addEvidence(target: PersonEvidence[], evidence: readonly PersonEvidence[]) {
  target.push(...evidence);
}

function selectedEvidence(
  context: PersonRelationshipQaSourceContext,
  intent: EvidenceIntent
) {
  const selected: PersonEvidence[] = [];

  if (intent === "changes") {
    for (const change of context.recentChanges) {
      addEvidence(selected, [change.evidence]);
      if (change.kind !== "fact") continue;
      const fact = context.recentFacts.find((candidate) => candidate.id === change.entityId);
      if (!fact) continue;
      addEvidence(selected, fact.evidence);
      if (fact.supersededBy) {
        const replacement = context.recentFacts.find(
          (candidate) => candidate.id === fact.supersededBy
        );
        if (replacement) addEvidence(selected, replacement.evidence);
      }
    }
    return selected;
  }

  if (intent === "commitments") {
    for (const commitment of [
      ...context.activeCommitments,
      ...context.completedCommitments
    ]) {
      addEvidence(selected, commitment.evidence);
      addEvidence(
        selected,
        commitment.transitions
          .filter((transition) => transition.applied)
          .map((transition) => transition.evidence)
      );
    }
    return selected;
  }

  for (const relationship of context.confirmedRelationships) {
    addEvidence(selected, relationship.evidence);
  }
  for (const fact of [...context.activeFacts, ...context.previousFacts]) {
    addEvidence(selected, fact.evidence);
  }
  for (const change of context.recentChanges) {
    addEvidence(selected, [change.evidence]);
  }
  for (const commitment of [
    ...context.activeCommitments,
    ...context.completedCommitments
  ]) {
    addEvidence(selected, commitment.evidence);
    addEvidence(
      selected,
      commitment.transitions
        .filter((transition) => transition.applied)
        .map((transition) => transition.evidence)
    );
  }
  return selected;
}

function normalizedEvidenceText(value: string) {
  return value
    .normalize("NFKC")
    .replace(/\r\n?/gu, "\n")
    .replace(/\s+/gu, " ")
    .trim();
}

function unambiguousEvidence(
  accountId: string,
  evidence: readonly PersonEvidence[]
) {
  const bySourceSegmentId = new Map<string, PersonEvidence[]>();
  for (const candidate of evidence) {
    const uploadId = candidate.uploadId.trim();
    const sourceSegmentId = candidate.sourceSegmentId.trim();
    const quote = normalizedEvidenceText(candidate.quote);
    if (
      candidate.accountId !== accountId ||
      !uploadId ||
      !sourceSegmentId ||
      !quote
    ) {
      continue;
    }
    const entries = bySourceSegmentId.get(sourceSegmentId) ?? [];
    entries.push(candidate);
    bySourceSegmentId.set(sourceSegmentId, entries);
  }

  return [...bySourceSegmentId.entries()].flatMap(([sourceSegmentId, candidates]) => {
    const signatures = new Set(candidates.map((candidate) => JSON.stringify([
      candidate.uploadId.trim(),
      normalizedEvidenceText(candidate.quote)
    ])));
    if (signatures.size !== 1) return [];
    const selected = [...candidates].sort(
      (left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
    )[0];
    return selected ? [{ ...selected, sourceSegmentId }] : [];
  });
}

type CurrentTranscriptUpload = {
  state: "available" | "missing" | "invalid";
  segments: TranscriptSegment[];
};

async function currentTranscriptSegments(
  store: Pick<JsonStore, "read">,
  evidence: readonly PersonEvidence[]
) {
  const uploads = [...new Set(evidence.map((item) => item.uploadId.trim()))];
  const entries = await Promise.all(uploads.map(async (
    uploadId
  ): Promise<readonly [string, CurrentTranscriptUpload]> => {
    try {
      const [rawUpload, rawSegments] = await Promise.all([
        store.read<unknown>("uploads", uploadId),
        store.read<unknown>("segments", uploadId)
      ]);
      if (rawUpload === null && rawSegments === null) {
        return [uploadId, { state: "missing", segments: [] }];
      }
      const upload = AudioUploadSchema.safeParse(rawUpload);
      const segments = z.array(TranscriptSegmentSchema).safeParse(rawSegments);
      if (
        !upload.success ||
        upload.data.id !== uploadId ||
        upload.data.status !== "ready" ||
        !segments.success
      ) {
        return [uploadId, { state: "invalid", segments: [] }];
      }
      return [uploadId, { state: "available", segments: segments.data }];
    } catch {
      return [uploadId, { state: "invalid", segments: [] }];
    }
  }));
  return new Map(entries);
}

/**
 * Projects only context-selected canonical person_evidence back to its current
 * Transcript source. Missing/deleted sources and ambiguous segment ids fail
 * closed instead of falling back to derived Person/Fact/Commitment text.
 */
export async function buildPersonRelationshipQaContext(input: {
  sourceContext: PersonRelationshipQaSourceContext;
  question: string;
  conversation: readonly QaConversationMessage[];
  settingsStore: Pick<JsonStore, "read">;
  trustedEvidenceResolver?: TrustedPersonQaEvidenceResolver;
}): Promise<PersonRelationshipQaContext> {
  if (
    !input.sourceContext.known ||
    !input.sourceContext.person
  ) {
    const blockedByUnavailableSelfRole = requiresUnavailableSelfPersonMapping(
      input.question,
      input.conversation
    );
    return {
      segments: [],
      eligibleSourceSegmentIds: [],
      blockedByUnavailableSelfRole,
      activeSelfPersonId: null
    };
  }

  const evidence = unambiguousEvidence(
    input.sourceContext.person.accountId,
    selectedEvidence(
      input.sourceContext,
      evidenceIntent(input.question, input.conversation)
    )
  );
  const trusted = input.trustedEvidenceResolver?.({
    accountId: input.sourceContext.person.accountId,
    personId: input.sourceContext.person.id,
    evidence
  }) ?? {
    segments: [],
    conflictingEvidenceKeys: [],
    activeSelfPersonId: null
  };
  const blockedByUnavailableSelfRole = requiresUnavailableSelfPersonMapping(
    input.question,
    input.conversation
  ) && !trusted.activeSelfPersonId;
  if (blockedByUnavailableSelfRole) {
    return {
      segments: [],
      eligibleSourceSegmentIds: [],
      blockedByUnavailableSelfRole,
      activeSelfPersonId: trusted.activeSelfPersonId
    };
  }
  const segmentsByUpload = await currentTranscriptSegments(input.settingsStore, evidence);
  const trustedByKey = new Map(trusted.segments.map((segment) => [
    personQaEvidenceKey(segment.uploadId, segment.id),
    segment
  ]));
  const conflictingKeys = new Set(trusted.conflictingEvidenceKeys);
  const segments = evidence.flatMap((item): TranscriptSegment[] => {
    const key = personQaEvidenceKey(item.uploadId, item.sourceSegmentId);
    if (conflictingKeys.has(key)) return [];
    const liveUpload = segmentsByUpload.get(item.uploadId.trim());
    if (!liveUpload || liveUpload.state === "invalid") return [];
    const snapshot = trustedByKey.get(key);
    if (liveUpload.state === "missing") {
      if (!snapshot || normalizedEvidenceText(snapshot.text) !== normalizedEvidenceText(item.quote)) {
        return [];
      }
      return [snapshot];
    }
    const source = liveUpload.segments.find(
      (candidate) => candidate.id === item.sourceSegmentId && candidate.uploadId === item.uploadId
    );
    if (
      !source ||
      normalizedEvidenceText(source.text) !== normalizedEvidenceText(item.quote)
    ) {
      return [];
    }
    if (
      snapshot && (
        source.startSeconds !== snapshot.startSeconds
        || source.endSeconds !== snapshot.endSeconds
        || (source.speaker?.normalize("NFKC").trim() || null)
          !== (snapshot.speaker?.normalize("NFKC").trim() || null)
        || normalizedEvidenceText(source.text) !== normalizedEvidenceText(snapshot.text)
      )
    ) {
      return [];
    }
    return [TranscriptSegmentSchema.parse({
      id: item.sourceSegmentId,
      uploadId: item.uploadId,
      startSeconds: source.startSeconds,
      endSeconds: source.endSeconds,
      text: item.quote.trim(),
      confidence: source.confidence,
      sceneLabels: [],
      valueLabels: []
    })];
  }).sort((left, right) =>
    left.uploadId.localeCompare(right.uploadId) ||
    left.startSeconds - right.startSeconds ||
    left.id.localeCompare(right.id)
  );

  return {
    segments,
    eligibleSourceSegmentIds: segments.map((segment) => segment.id),
    blockedByUnavailableSelfRole,
    activeSelfPersonId: trusted.activeSelfPersonId
  };
}

export async function buildPersonRelationshipQaInput(input: {
  userId: string;
  personId: string;
  question: string;
  conversation: QaConversationMessage[];
  settingsStore: JsonStore;
  sourceContext: PersonRelationshipQaSourceContext;
  trustedEvidenceResolver?: TrustedPersonQaEvidenceResolver;
}): Promise<AnswerQuestionWithAIInput> {
  const context = await buildPersonRelationshipQaContext(input);
  return {
    userId: input.userId,
    uploadId: input.personId,
    question: input.question,
    ...(input.conversation.length > 0 ? { conversation: input.conversation } : {}),
    relationshipScope: true,
    qaPromptInstruction: PERSON_QA_PROMPT_INSTRUCTION,
    settingsStore: input.settingsStore,
    segments: context.segments,
    audioInsights: [],
    semanticSegments: [],
    briefItems: [],
    relationshipSignals: [],
    disableHybridRetrieval: true,
    failClosedOnModelProviderMismatch: true
  };
}
