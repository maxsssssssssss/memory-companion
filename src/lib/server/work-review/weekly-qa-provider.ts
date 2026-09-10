import { z } from "zod";

import {
  WORK_WEEKLY_MAX_QA_TURNS,
  WorkWeeklyQaMessageSchema,
  type WorkWeeklyQaMessage,
  type WorkWeeklySourceSnapshot
} from "@/lib/domain/work-weekly";

import {
  WORK_WEEKLY_QA_ANSWERER_SCHEMA_VERSION,
  WORK_WEEKLY_QA_ANSWERER_PROFILE_ID,
  WORK_WEEKLY_QA_ANSWERER_PROMPT_VERSION,
  WORK_WEEKLY_QA_VERIFIER_SCHEMA_VERSION,
  WorkWeeklyGeneratedClaimSchema,
  WorkWeeklyVerifierResponseSchema,
  assertWorkWeeklySnapshotAuthority,
  requestWorkWeeklyStructuredJson,
  resolveWorkWeeklyProviderProfile,
  resolveWorkWeeklySourceRecord,
  validateWorkWeeklyVerifierOutput,
  type WorkWeeklyGeneratedClaim,
  type WorkWeeklyProviderProfile,
  type WorkWeeklyStructuredJsonRequest,
  type WorkWeeklyVerifierItem
} from "./weekly-ai-provider";
import { applyWorkWeeklyClaimPublicationPolicy } from "./weekly-publication-policy";

export const WORK_WEEKLY_QA_INSUFFICIENT_ANSWER =
  "在本周已确认的工作记录中，没有找到足够依据回答这个问题。" as const;

export const WorkWeeklyQaAnswerDraftSchema = z.object({
  status: z.enum(["answered", "partially_answered", "insufficient_evidence"]),
  answer: z.string().max(20_000),
  claims: z.array(WorkWeeklyGeneratedClaimSchema).max(64),
  relevantSourceRefs: z.array(z.string().trim().min(1).max(1_024)).max(256)
}).strict().superRefine((draft, context) => {
  if (new Set(draft.relevantSourceRefs).size !== draft.relevantSourceRefs.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["relevantSourceRefs"], message: "Duplicate sourceRefs" });
  }
  if (draft.status === "insufficient_evidence" && draft.claims.length > 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["claims"], message: "Insufficient answers cannot contain claims" });
  }
});

export type WorkWeeklyQaAnswerDraft = z.infer<typeof WorkWeeklyQaAnswerDraftSchema>;

export type WorkWeeklyQaHistoryContext = {
  recentMessages: Array<{ role: "user" | "assistant"; text: string }>;
  olderUserIntents: string[];
};

export type WorkWeeklyQaSourceUnit = {
  primarySourceRef: string;
  sourceRefs: string[];
  sourceKind: "finding" | "todo";
  localDate: string;
  score: number;
  value: unknown;
};

export type WorkWeeklyQaSourcePack = {
  contractVersion: 1;
  question: string;
  scope: WorkWeeklySourceSnapshot["scope"];
  snapshotDigest: string;
  inputPackDigest: string;
  history: WorkWeeklyQaHistoryContext;
  units: WorkWeeklyQaSourceUnit[];
  allowlistedSourceRefs: string[];
};

function normalize(value: string) {
  return value.toLocaleLowerCase("en-US").replace(/\s+/gu, " ").trim();
}

function searchTerms(question: string) {
  const normalized = normalize(question);
  const terms = new Set<string>();
  for (const word of normalized.match(/[a-z0-9][a-z0-9_-]+/gu) ?? []) terms.add(word);
  for (const sequence of normalized.match(/[\p{Script=Han}]+/gu) ?? []) {
    if (sequence.length <= 3) terms.add(sequence);
    for (let index = 0; index < sequence.length - 1; index += 1) {
      terms.add(sequence.slice(index, index + 2));
    }
  }
  return [...terms].filter((term) => term.length >= 2);
}

function projectRef(snapshot: WorkWeeklySourceSnapshot, projectId: string) {
  return snapshot.identities.find((identity) =>
    identity.included && identity.sourceKind === "project" && identity.sourceId === projectId
  )?.sourceRef ?? null;
}

function lexicalScore(question: string, text: string) {
  const haystack = normalize(text);
  return searchTerms(question).reduce((score, term) => score + (haystack.includes(term) ? 4 : 0), 0);
}

function intentScore(question: string, unit: WorkWeeklyQaSourceUnit) {
  const normalized = normalize(question);
  const value = JSON.stringify(unit.value);
  let score = 0;
  if (/决定|方案/u.test(normalized) && /"kind":"(?:decision|plan_change)"/u.test(value)) score += 12;
  if (/完成|做完|结束/u.test(normalized) && /todo\.completed|"status":"completed"/u.test(value)) score += 12;
  if (/等待|别人|他人/u.test(normalized) && /waiting_for_other/u.test(value)) score += 12;
  if (/未解决|没结束|进行中|还有什么/u.test(normalized)
    && /open_question|"status":"open"/u.test(value)) score += 10;
  if (/截止|到期|逾期|日期/u.test(normalized) && /Due|due|currentDueDate/u.test(value)) score += 10;
  if (/为什么|原因|考虑/u.test(normalized) && unit.sourceKind === "finding") score += 8;
  if (/会议|讨论/u.test(normalized) && unit.sourceKind === "finding") score += 6;
  if (/本周|这周|推进|主要工作|做了什么/u.test(normalized)) score += 1;
  return score;
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function buildWorkWeeklyQaHistoryContext(input: {
  accountId: string;
  weeklyReviewId: string;
  snapshotDigest: string;
  messages?: WorkWeeklyQaMessage[];
}): WorkWeeklyQaHistoryContext {
  const messages = (input.messages ?? []).map((message) => WorkWeeklyQaMessageSchema.parse(message))
    .filter((message) => message.accountId === input.accountId
      && message.weeklyReviewId === input.weeklyReviewId
      && message.text !== null
      && message.invalidatedAt === null
      && (message.role === "user"
        || (message.sourceSnapshotDigest === input.snapshotDigest
          && (message.answerStatus === "answered" || message.answerStatus === "partially_answered"))))
    .sort((left, right) => compareText(left.createdAt, right.createdAt) || compareText(left.id, right.id));
  const maximumMessages = WORK_WEEKLY_MAX_QA_TURNS * 2;
  const recent = messages.slice(-maximumMessages);
  const older = messages.slice(0, Math.max(0, messages.length - maximumMessages));
  return {
    recentMessages: recent.map((message) => ({
      role: message.role,
      text: message.text!.slice(0, 4_000)
    })),
    olderUserIntents: older.filter((message) => message.role === "user")
      .slice(-WORK_WEEKLY_MAX_QA_TURNS)
      .map((message) => message.text!.slice(0, 240))
  };
}

function candidateUnits(snapshot: WorkWeeklySourceSnapshot, question: string) {
  const meetingById = new Map(snapshot.meetings.map((meeting) => [meeting.id, meeting]));
  const eventsByTodo = new Map<string, typeof snapshot.todoEvents>();
  for (const event of snapshot.todoEvents) {
    const list = eventsByTodo.get(event.todoId) ?? [];
    list.push(event);
    eventsByTodo.set(event.todoId, list);
  }
  const units: WorkWeeklyQaSourceUnit[] = [];
  for (const finding of snapshot.findings) {
    const meeting = meetingById.get(finding.meetingId);
    if (!meeting) continue;
    const projectRefs = meeting.projects.map((project) => projectRef(snapshot, project.id))
      .filter((ref): ref is string => ref !== null);
    const sourceRefs = [...new Set([
      finding.sourceRef,
      meeting.sourceRef,
      ...projectRefs,
      ...finding.evidenceRefs
    ])].sort();
    const value = { finding, meeting: {
      sourceRef: meeting.sourceRef,
      id: meeting.id,
      title: meeting.title,
      meetingDate: meeting.meetingDate,
      projects: meeting.projects
    } };
    const unit: WorkWeeklyQaSourceUnit = {
      primarySourceRef: finding.sourceRef,
      sourceRefs,
      sourceKind: "finding",
      localDate: meeting.meetingDate,
      score: 0,
      value
    };
    unit.score = lexicalScore(question, JSON.stringify(value)) + intentScore(question, unit);
    units.push(unit);
  }
  for (const todo of snapshot.todos) {
    const events = eventsByTodo.get(todo.id) ?? [];
    const projectRefs = todo.projects.map((project) => projectRef(snapshot, project.id))
      .filter((ref): ref is string => ref !== null);
    const sourceRefs = [...new Set([
      todo.sourceRef,
      ...events.map((event) => event.sourceRef),
      ...projectRefs
    ])].sort();
    const value = { todo, events };
    const unit: WorkWeeklyQaSourceUnit = {
      primarySourceRef: todo.sourceRef,
      sourceRefs,
      sourceKind: "todo",
      localDate: events.length > 0
        ? events[events.length - 1]!.localDate
        : snapshot.scope.weekStart,
      score: 0,
      value
    };
    unit.score = lexicalScore(question, JSON.stringify(value)) + intentScore(question, unit);
    units.push(unit);
  }
  return units;
}

export function buildWorkWeeklyQaSourcePack(input: {
  accountId: string;
  weeklyReviewId: string;
  snapshot: WorkWeeklySourceSnapshot;
  question: string;
  history?: WorkWeeklyQaMessage[];
  maxUnits?: number;
  maxUtf8Bytes?: number;
}): WorkWeeklyQaSourcePack {
  const snapshot = assertWorkWeeklySnapshotAuthority(input);
  const question = input.question.trim();
  if (!question || question.length > 8_000) throw new Error("work_weekly_qa_question_invalid");
  const maxUnits = Math.max(1, Math.min(input.maxUnits ?? 16, 64));
  const maxUtf8Bytes = Math.max(1_024, Math.min(input.maxUtf8Bytes ?? 64 * 1_024, 256 * 1_024));
  const candidates = candidateUnits(snapshot, question).filter((unit) => unit.score > 0)
    .sort((left, right) => right.score - left.score
      || compareText(right.localDate, left.localDate)
      || compareText(left.primarySourceRef, right.primarySourceRef));
  const units: WorkWeeklyQaSourceUnit[] = [];
  let bytes = 0;
  for (const unit of candidates) {
    const size = Buffer.byteLength(JSON.stringify(unit), "utf8");
    if (units.length >= maxUnits || bytes + size > maxUtf8Bytes) continue;
    units.push(unit);
    bytes += size;
  }
  const snapshotAllowlist = new Set(snapshot.allowlistedSourceRefs);
  const allowlistedSourceRefs = [...new Set(units.flatMap((unit) => unit.sourceRefs))]
    .filter((ref) => snapshotAllowlist.has(ref)).sort();
  if (units.some((unit) => unit.sourceRefs.some((ref) => !snapshotAllowlist.has(ref)))) {
    throw new Error("work_weekly_qa_source_not_allowlisted");
  }
  return {
    contractVersion: 1,
    question,
    scope: snapshot.scope,
    snapshotDigest: snapshot.digest,
    inputPackDigest: snapshot.inputPackDigest,
    history: buildWorkWeeklyQaHistoryContext({
      accountId: input.accountId,
      weeklyReviewId: input.weeklyReviewId,
      snapshotDigest: snapshot.digest,
      messages: input.history
    }),
    units,
    allowlistedSourceRefs
  };
}

export interface WorkWeeklyQaAnswerer {
  readonly profile: WorkWeeklyProviderProfile;
  answer(input: { sourcePack: WorkWeeklyQaSourcePack; signal?: AbortSignal }): Promise<WorkWeeklyQaAnswerDraft>;
}

export interface WorkWeeklyQaVerifier {
  readonly profile: WorkWeeklyProviderProfile;
  verify(input: {
    snapshot: WorkWeeklySourceSnapshot;
    sourcePack: WorkWeeklyQaSourcePack;
    claims: WorkWeeklyGeneratedClaim[];
    signal?: AbortSignal;
  }): Promise<WorkWeeklyVerifierItem[]>;
}

const QA_ANSWERER_SYSTEM_PROMPT = [
  "你是 Work Weekly QA Answerer。只能回答当前 Source Pack 所属账号、自然周和项目范围的问题。",
  "history 仅用于理解代词和连续提问，上一轮 assistant 文本绝不是 Evidence；每个新事实都必须重新引用 sources。",
  "不得读取 Weekly 用户编辑内容、Follow-up、Pending Candidate、其他周/项目/账号或 Daily、Date、Memory、Person、generic retrieval、互联网。",
  "提议不是决定，任务分配不是承诺，Todo completed 只表示系统中标记完成，日期不自动是 deadline，先后不等于因果，单条来源不等于反复。",
  "不要返回 quote；只返回 sourceRef。来源不足时 status=insufficient_evidence，不用一般知识补造用户工作历史。"
].join("\n");

const QA_VERIFIER_SYSTEM_PROMPT = [
  "你是独立 Work Weekly QA Claim Verifier。只核验每个 claim 与它引用的当前 Source Pack sources。",
  "不得把 history、Answerer answer、其他 claim 或未引用来源当 Evidence。",
  "只有 Evidence 明确表达理由时才能支持 causality；assignment_without_acceptance 不是 commitment；Todo completed 不是现实履行；一个来源不支持频率。",
  "来源不足必须返回 unsupported、contradicted 或 unverifiable。"
].join("\n");

export const WORK_WEEKLY_QA_ANSWERER_JSON_INSTRUCTION =
  "输出严格 JSON {status,answer,claims:[{id,text,claimType,sourceRefs}],relevantSourceRefs}。" +
  "sourceRefs 只能来自 Source Pack；禁止 quote 字段；insufficient_evidence 时 claims 必须为空。";

export const WORK_WEEKLY_QA_VERIFIER_JSON_INSTRUCTION =
  "输出严格 JSON {items:[{claimId,verdict,issueCodes,supportedSourceRefs}]}；" +
  "每个 claim 恰好一项，supportedSourceRefs 只能是该 claim sourceRefs 子集。";

export function createStructuredWorkWeeklyQaAnswerer(input: {
  profile: WorkWeeklyProviderProfile;
  requestStructuredJson?: WorkWeeklyStructuredJsonRequest;
}): WorkWeeklyQaAnswerer {
  if (input.profile.role !== "qa_answerer" || input.profile.provider === "fixture") {
    throw new Error("work_weekly_qa_answerer_profile_invalid");
  }
  const request = input.requestStructuredJson ?? requestWorkWeeklyStructuredJson;
  return {
    profile: input.profile,
    async answer(call) {
      const response = await request({
        profile: input.profile,
        schema: WorkWeeklyQaAnswerDraftSchema,
        requestInput: [
          { role: "system", content: QA_ANSWERER_SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify(call.sourcePack) }
        ],
        jsonInstruction: WORK_WEEKLY_QA_ANSWERER_JSON_INSTRUCTION,
        signal: call.signal
      });
      const parsed = WorkWeeklyQaAnswerDraftSchema.safeParse(response);
      if (!parsed.success) throw new Error("work_weekly_qa_answer_invalid");
      const allowlist = new Set(call.sourcePack.allowlistedSourceRefs);
      if (parsed.data.relevantSourceRefs.some((ref) => !allowlist.has(ref))
        || parsed.data.claims.some((claim) => claim.sourceRefs.some((ref) => !allowlist.has(ref)))) {
        throw new Error("work_weekly_qa_source_not_allowlisted");
      }
      return parsed.data;
    }
  };
}

export function createStructuredWorkWeeklyQaVerifier(input: {
  profile: WorkWeeklyProviderProfile;
  requestStructuredJson?: WorkWeeklyStructuredJsonRequest;
}): WorkWeeklyQaVerifier {
  if (input.profile.role !== "qa_verifier" || input.profile.provider === "fixture") {
    throw new Error("work_weekly_qa_verifier_profile_invalid");
  }
  const request = input.requestStructuredJson ?? requestWorkWeeklyStructuredJson;
  return {
    profile: input.profile,
    async verify(call) {
      const packAllowlist = new Set(call.sourcePack.allowlistedSourceRefs);
      if (call.claims.some((claim) => claim.sourceRefs.some((ref) => !packAllowlist.has(ref)))) {
        throw new Error("work_weekly_qa_source_not_allowlisted");
      }
      const response = await request({
        profile: input.profile,
        schema: WorkWeeklyVerifierResponseSchema,
        requestInput: [
          { role: "system", content: QA_VERIFIER_SYSTEM_PROMPT },
          {
            role: "user",
            content: JSON.stringify({
              snapshotDigest: call.sourcePack.snapshotDigest,
              items: call.claims.map((claim) => ({
                claim,
                sources: claim.sourceRefs.map((ref) => resolveWorkWeeklySourceRecord(
                  call.snapshot, ref
                ))
              }))
            })
          }
        ],
        jsonInstruction: WORK_WEEKLY_QA_VERIFIER_JSON_INSTRUCTION,
        signal: call.signal
      });
      return validateWorkWeeklyVerifierOutput({ response, claims: call.claims });
    }
  };
}

export function createConfiguredWorkWeeklyQaProviders(input: {
  env?: Readonly<Record<string, string | undefined>>;
  requestStructuredJson?: WorkWeeklyStructuredJsonRequest;
} = {}) {
  return {
    answerer: createStructuredWorkWeeklyQaAnswerer({
      profile: resolveWorkWeeklyProviderProfile("qa_answerer", input.env),
      requestStructuredJson: input.requestStructuredJson
    }),
    verifier: createStructuredWorkWeeklyQaVerifier({
      profile: resolveWorkWeeklyProviderProfile("qa_verifier", input.env),
      requestStructuredJson: input.requestStructuredJson
    })
  };
}

export type WorkWeeklyQaFinalAnswer = {
  answerStatus: "answered" | "partially_answered" | "insufficient_evidence";
  answer: string;
  sourceRefs: string[];
  providerProfile: string;
  promptVersion: string;
  verifierProfile: string | null;
  failureCode: string | null;
};

function insufficient(input: {
  answerer: WorkWeeklyQaAnswerer | null;
  verifier: WorkWeeklyQaVerifier | null;
  failureCode: string;
}): WorkWeeklyQaFinalAnswer {
  return {
    answerStatus: "insufficient_evidence",
    answer: WORK_WEEKLY_QA_INSUFFICIENT_ANSWER,
    sourceRefs: [],
    providerProfile: input.answerer?.profile.id ?? WORK_WEEKLY_QA_ANSWERER_PROFILE_ID,
    promptVersion: input.answerer?.profile.promptVersion ?? WORK_WEEKLY_QA_ANSWERER_PROMPT_VERSION,
    verifierProfile: input.verifier?.profile.id ?? null,
    failureCode: input.failureCode
  };
}

function isPerformanceQuestion(question: string) {
  const normalized = normalize(question.normalize("NFKC").replace(/\p{Cf}/gu, ""));
  const compact = normalized.replace(/[\s\p{P}]/gu, "");
  // A confirmed task/owner is not authority for personnel assessment. Match intent
  // families before source selection; neither GPT role may invent that authority.
  const personnel = /谁|哪位|哪个人|某人|人员|个人|员工|同事|成员|团队/u.test(compact);
  if ([
    /晋升|晋级|升职|升迁|提拔|降职|辞退|解雇/u,
    /绩效|工作表现|工作能力|工作态度|敬业|胜任|尽责|失职|偷懒|懒惰/u,
    /(?:工作|贡献|效率|表现|能力|工作量)(?:最[多少高低好差大小]|排名|排行|排序)/u,
    /归咎|背锅|问责|追责|过错|谁的错|(?:承担|负有|担负)责任/u,
    /(?:是否|是不是|算不算|够不够)(?:一个|很|足够)?负责任?(?:吗|呢|的人|的员工|的同事)?$/u,
    /(?:该|应该|应当|需要|必须|要)(?:为|对).{0,24}负责|(?:为|对).{0,24}(?:该|应该|应当|需要|必须|要)负责/u,
    /士气|心理|心态|内心|动机|情绪|焦虑|抑郁|忠诚|积极性|故意|蓄意/u
  ].some((pattern) => pattern.test(compact))) return true;
  if (personnel && /排名|排行|排序|打分|评分|评价|评估|能力|效率|贡献|工作量|靠谱|可靠|抵触|不满/u.test(compact)) {
    return true;
  }
  return /\b(?:promot(?:e|ed|ion)|demot(?:e|ed|ion)|blame|fault|culpab\w*|morale|psycholog\w*|motivat\w*|lazy|laziness|mental|loyalty)\b/u.test(normalized)
    || /\b(?:who|employee|person|people|member|colleague|team)\b.*\b(?:rank\w*|perform\w*|efficien\w*|contribut\w*|attitude|responsible|accountable|best|worst|most|least)\b/u.test(normalized)
      && !/\bresponsible for\b/u.test(normalized)
    || /\b(?:rank|rate|assess|evaluate)\b.*\b(?:employee|people|member|colleague|team)\b/u.test(normalized);
}

export async function answerWorkWeeklyQuestion(input: {
  accountId: string;
  weeklyReviewId: string;
  snapshot: WorkWeeklySourceSnapshot;
  question: string;
  history?: WorkWeeklyQaMessage[];
  answerer: WorkWeeklyQaAnswerer | null;
  verifier: WorkWeeklyQaVerifier | null;
  signal?: AbortSignal;
}): Promise<WorkWeeklyQaFinalAnswer> {
  assertWorkWeeklySnapshotAuthority(input);
  if (isPerformanceQuestion(input.question)) {
    return insufficient({ ...input, failureCode: "weekly_qa_performance_question_refused" });
  }
  const sourcePack = buildWorkWeeklyQaSourcePack(input);
  if (sourcePack.units.length === 0) {
    return insufficient({ ...input, failureCode: "weekly_qa_no_relevant_sources" });
  }
  if (!input.answerer || !input.verifier) {
    return insufficient({ ...input, failureCode: "weekly_qa_verifier_unavailable" });
  }
  const answerer = input.answerer;
  const verifier = input.verifier;
  try {
    const draft = await answerer.answer({ sourcePack, signal: input.signal });
    if (draft.status === "insufficient_evidence" || draft.claims.length === 0) {
      return insufficient({ ...input, failureCode: "weekly_qa_answerer_insufficient" });
    }
    const verdicts = await verifier.verify({
      snapshot: input.snapshot,
      sourcePack,
      claims: draft.claims,
      signal: input.signal
    });
    const published = applyWorkWeeklyClaimPublicationPolicy({
      snapshot: input.snapshot,
      items: [{
        id: "qa_answer",
        section: "overview",
        itemType: "evidence_backed_fact",
        text: draft.answer || "QA answer",
        claims: draft.claims
      }],
      verdicts
    });
    if (published.length === 0) {
      return insufficient({ ...input, failureCode: "weekly_qa_no_safe_claims" });
    }
    const item = published[0]!;
    const partial = draft.status === "partially_answered"
      || item.verificationState === "qualified"
      || verdicts.some((verdict) => verdict.verdict !== "entailed");
    return {
      answerStatus: partial ? "partially_answered" : "answered",
      answer: item.text,
      sourceRefs: item.sourceRefs,
      providerProfile: answerer.profile.id,
      promptVersion: answerer.profile.promptVersion,
      verifierProfile: verifier.profile.id,
      failureCode: null
    };
  } catch {
    return insufficient({ ...input, failureCode: "weekly_qa_provider_or_contract_failed" });
  }
}

export const WORK_WEEKLY_QA_SCHEMA_NAMES = {
  answerer: WORK_WEEKLY_QA_ANSWERER_SCHEMA_VERSION,
  verifier: WORK_WEEKLY_QA_VERIFIER_SCHEMA_VERSION
} as const;
