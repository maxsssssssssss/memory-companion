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
  type WorkWeeklyProviderUsage,
  type WorkWeeklyStructuredJsonRequest,
  type WorkWeeklyVerifierItem
} from "./weekly-ai-provider";
import { applyWorkWeeklyClaimPublicationPolicy } from "./weekly-publication-policy";
import {
  WorkWeeklyQaTechnicalError,
  assertWorkWeeklyQaNotCancelled,
  classifyWorkWeeklyQaError,
  emitWorkWeeklyQaDiagnostic,
  workWeeklyQaReasonCounts,
  workWeeklyQaSchemaIssues,
  type WorkWeeklyQaDiagnosticObserver,
  type WorkWeeklyQaStage
} from "./weekly-qa-diagnostics";

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
  answer(input: { sourcePack: WorkWeeklyQaSourcePack; signal?: AbortSignal;
    onMetrics?: (metrics: WorkWeeklyQaRequestMetrics) => void }): Promise<WorkWeeklyQaAnswerDraft>;
}

type WorkWeeklyQaRequestMetrics = WorkWeeklyProviderUsage & { inputBytes?: number };

export interface WorkWeeklyQaVerifier {
  readonly profile: WorkWeeklyProviderProfile;
  verify(input: {
    snapshot: WorkWeeklySourceSnapshot;
    sourcePack: WorkWeeklyQaSourcePack;
    claims: WorkWeeklyGeneratedClaim[];
    signal?: AbortSignal;
    onMetrics?: (metrics: WorkWeeklyQaRequestMetrics) => void;
  }): Promise<WorkWeeklyVerifierItem[]>;
}

const QA_ANSWERER_SYSTEM_PROMPT = [
  "你是 Work Weekly QA Answerer。只能回答当前 Source Pack 所属账号、自然周和项目范围的问题。",
  "先给简短结论，再用少量必要要点回答本题，不逐条复述全部来源。背景、观察日或本周尚未结束等限制仅在影响本题判断时说明，避免重复前置条件。claims[].text就是最终正文：每项是自足的自然短段落，必要时用列表；不写核验过程或内部术语，不为填满格式扩写，复杂问题可按实际需要展开。",
  "区分条件、未知与已知事实：如果发生某情况时才适用的安排，不证明该情况已经发生；尚未验证或不能认定通过，也不证明资源缺失或验证失败。保留原条件，不把可能原因写成现状。",
  "用户问下一步时，按待办标题、事件及明确相关的安排提取已有动作和必要前提，并引用对应来源，不能只复述状态。未完成不表示已开始；没有后续动作依据就说明记录未给出，不另造负责人、期限或执行结果。",
  "history 仅用于理解代词和连续提问，上一轮 assistant 文本绝不是 Evidence；每个新事实都必须重新引用 sources。",
  "不得读取 Weekly 用户编辑内容、Follow-up、Pending Candidate、其他周/项目/账号或 Daily、Date、Memory、Person、generic retrieval、互联网。",
  "提议不是决定，任务分配不是承诺，Todo completed 只表示系统中标记完成，日期不自动是 deadline，先后不等于因果，单条来源不等于反复。",
  "Source Pack 中的 confirmed Finding、Todo 当前/观察截止状态、Todo event 都可独立支持对应问题；不要求同时存在会议、Todo 或多条事件。静态 Todo 只能支持已记录状态，不能补造变更过程。",
  "按 scope.observedThrough 描述已观察范围；windowComplete=false 时不得声称全周已经结束。Todo 重开后的观察截止状态是 open，历史 completed 不证明当前完成或现实交付。",
  "Todo stateAtWeekEnd 是周范围观察截止状态，current 是查询时当前状态；截止状态未知时不得用 current 补造历史。用本周 events 描述已记录操作，不推断未记录的状态变更。",
  "面向用户的中文 answer 与 claims[].text 使用一致的自然状态表述：Todo open 写作“未完成”，completed 写作“已标记完成”，仅描述系统记录，不推断实际交付。",
  "若证据显示完成后重开，自然说明先前标记与当前未完成的区别，不要求固定句式。同一事项的必要条件放在同一段；仅在问题涉及实际交付时简要区分系统状态与现实结果，不在每条后重复免责声明。用户标题和来源英文照原意保留，字段名/sourceRef不翻译。",
  "不要返回 quote；只返回 sourceRef。来源不足时 status=insufficient_evidence，不用一般知识补造用户工作历史。"
].join("\n");

const QA_VERIFIER_SYSTEM_PROMPT = [
  "你是独立 Work Weekly QA Claim Verifier。只核验每个 claim 与它引用的当前 Source Pack sources。",
  "sources按sourceRef集中去重；每个claim只能使用其sourceRefs对应的记录。比较实际含义，接受忠实概括、自然改写和结论在前的段落，不要求固定句式或逐条重复系统状态免责声明。改变结论的必要条件仍须保留在同一claim。",
  "逐个分句核对断言强度：条件句不证明前提成立，未验证或尚不能认定通过不证明资源缺失、已经失败或已经通过；来源只给条件/未知而claim肯定现状时，不得entailed，应标unsupported或partially_entailed。动作已有记录不证明前提已满足或动作已执行。",
  "不得把 history、Answerer answer、其他 claim 或未引用来源当 Evidence。",
  "只有 Evidence 明确表达理由时才能支持 causality；assignment_without_acceptance 不是 commitment；Todo completed 不是现实履行；一个来源不支持频率。",
  "记录本身可核验：confirmed Finding 不要求 Todo 配套；Todo 和 event 不要求会议配套。逐字区分当前/观察截止状态与历史操作，重新打开后的状态不能仍说已完成。",
  "以 scope 的 observedThrough/windowComplete 和 Todo stateAtWeekEnd 核验周范围截止状态；current 仅代表查询时状态，不能填补未知历史。",
  "来源不足必须返回 unsupported、contradicted 或 unverifiable。"
].join("\n");

export const WORK_WEEKLY_QA_ANSWERER_JSON_INSTRUCTION =
  "输出严格 JSON {status,answer,claims:[{id,text,claimType,sourceRefs}],relevantSourceRefs}。" +
  "status 只能是 answered、partially_answered、insufficient_evidence；answer填空字符串，正文只写在claims[].text，发布只使用核验通过的claim.text，不重复生成两份回答。" +
  "claimType 只能是 fact、person、decision、commitment、deadline、completion、causality、frequency、temporal_order。" +
  "普通记录/状态用 fact；完成事件用 completion 且明确是系统标记。claims 最多32项，id非空且唯一，每项text为独立完整事实，sourceRefs非空且不重复。" +
  "sourceRefs 和 relevantSourceRefs 只能来自 Source Pack，后者不重复；禁止 quote 和额外字段；insufficient_evidence 时 claims 必须为空，其余状态必须有claim。";

export const WORK_WEEKLY_QA_VERIFIER_JSON_INSTRUCTION =
  "输出严格 JSON {items:[{claimId,verdict,issueCodes,supportedSourceRefs}]}；" +
  "verdict 只能是 entailed、partially_entailed、unsupported、contradicted、unverifiable。" +
  "每个 claim 恰好一项且claimId逐字对应、不重复，supportedSourceRefs不重复且只能是该 claim sourceRefs 子集。" +
  "issueCodes是字符串数组，无问题时[]；只有entailed且issueCodes为空并有supportedSourceRefs才可发布，partially_entailed不发布。禁止额外字段。";

function validateQaDraft(response: unknown, sourcePack: WorkWeeklyQaSourcePack) {
  const parsed = WorkWeeklyQaAnswerDraftSchema.safeParse(response);
  if (!parsed.success) throw new WorkWeeklyQaTechnicalError("weekly_qa_answer_invalid", "answerer", parsed.error);
  const draft = parsed.data;
  if ((draft.status !== "insufficient_evidence" && draft.claims.length === 0)
    || new Set(draft.claims.map((claim) => claim.id)).size !== draft.claims.length) {
    throw new WorkWeeklyQaTechnicalError("weekly_qa_answer_invalid", "answerer");
  }
  const allowlist = new Set(sourcePack.allowlistedSourceRefs);
  if (draft.relevantSourceRefs.some((ref) => !allowlist.has(ref))
    || draft.claims.some((claim) => claim.sourceRefs.some((ref) => !allowlist.has(ref)))) {
    throw new WorkWeeklyQaTechnicalError("weekly_qa_source_not_allowlisted", "answerer");
  }
  return draft;
}

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
      // Ranking metadata and digests stay authoritative locally; all selected
      // canonical values, scope, history and exact citation allowlist stay on wire.
      const content = JSON.stringify({ question: call.sourcePack.question, scope: call.sourcePack.scope,
        history: call.sourcePack.history,
        units: call.sourcePack.units.map(({ sourceKind, value }) => ({ sourceKind, value })),
        allowlistedSourceRefs: call.sourcePack.allowlistedSourceRefs });
      call.onMetrics?.({ inputBytes: Buffer.byteLength(content, "utf8") });
      const response = await request({
        profile: input.profile,
        schema: WorkWeeklyQaAnswerDraftSchema,
        requestInput: [
          { role: "system", content: QA_ANSWERER_SYSTEM_PROMPT },
          { role: "user", content }
        ],
        jsonInstruction: WORK_WEEKLY_QA_ANSWERER_JSON_INSTRUCTION,
        signal: call.signal,
        onUsage: call.onMetrics
      });
      return validateQaDraft(response, call.sourcePack);
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
        throw new WorkWeeklyQaTechnicalError("weekly_qa_source_not_allowlisted", "verifier");
      }
      const content = JSON.stringify({ scope: call.sourcePack.scope,
        items: call.claims.map((claim) => ({ claim })),
        sources: [...new Set(call.claims.flatMap((claim) => claim.sourceRefs))]
          .map((ref) => resolveWorkWeeklySourceRecord(call.snapshot, ref)) });
      call.onMetrics?.({ inputBytes: Buffer.byteLength(content, "utf8") });
      const response = await request({
        profile: input.profile,
        schema: WorkWeeklyVerifierResponseSchema,
        requestInput: [
          { role: "system", content: QA_VERIFIER_SYSTEM_PROMPT },
          {
            role: "user",
            content
          }
        ],
        jsonInstruction: WORK_WEEKLY_QA_VERIFIER_JSON_INSTRUCTION,
        signal: call.signal,
        onUsage: call.onMetrics
      });
      // Preserve sanitized schema paths before the shared contract validator reports counts.
      const parsed = WorkWeeklyVerifierResponseSchema.safeParse(response);
      if (!parsed.success) throw new WorkWeeklyQaTechnicalError("weekly_qa_verifier_invalid", "verifier", parsed.error);
      return validateWorkWeeklyVerifierOutput({ response: parsed.data, claims: call.claims });
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
  onDiagnostic?: WorkWeeklyQaDiagnosticObserver;
}): Promise<WorkWeeklyQaFinalAnswer> {
  let stage: WorkWeeklyQaStage = "source_selection";
  const startedAt = performance.now();
  let stageStartedAt = startedAt;
  let metrics: WorkWeeklyQaRequestMetrics = {};
  const captureMetrics = (next: WorkWeeklyQaRequestMetrics) => {
    for (const key of ["inputBytes", "inputTokens", "outputTokens", "reasoningTokens"] as const) {
      const value = next[key];
      if (Number.isSafeInteger(value) && value! >= 0) metrics[key] = value;
    }
  };
  const emit = (event: Parameters<WorkWeeklyQaDiagnosticObserver>[0]) => {
    const profile = stage === "answerer" ? input.answerer?.profile : stage === "verifier" ? input.verifier?.profile : null;
    return emitWorkWeeklyQaDiagnostic(input.onDiagnostic, {
      elapsedMs: Math.round(performance.now() - stageStartedAt),
      totalElapsedMs: Math.round(performance.now() - startedAt),
      ...(profile ? { role: stage === "answerer" ? "qa_answerer" as const : "qa_verifier" as const,
        model: (["deepseek-v4-flash", "deepseek-v4-pro", "gpt-5.5"] as const).find((model) => model === profile.model) ?? "other",
        effectiveTimeoutMs: profile.timeoutMs, maxOutputTokens: profile.maxOutputTokens, ...metrics } : {}),
      ...event
    });
  };
  const notSupported = async (reasonCode: "weekly_qa_performance_question_refused" | "weekly_qa_no_relevant_sources"
    | "weekly_qa_answerer_insufficient" | "weekly_qa_no_safe_claims") => {
    await emit({ stage, outcome: "insufficient_evidence", reasonCode });
    return insufficient({ ...input, failureCode: reasonCode });
  };
  try {
    assertWorkWeeklyQaNotCancelled(input.signal);
    assertWorkWeeklySnapshotAuthority(input);
    if (isPerformanceQuestion(input.question)) {
      return await notSupported("weekly_qa_performance_question_refused");
    }
    const sourcePack = buildWorkWeeklyQaSourcePack(input);
    await emit({ stage, outcome: "succeeded", sourceUnitCount: sourcePack.units.length,
      sourcePackBytes: Buffer.byteLength(JSON.stringify(sourcePack), "utf8"),
      historyBytes: Buffer.byteLength(JSON.stringify(sourcePack.history), "utf8"),
      sourceRefCount: sourcePack.allowlistedSourceRefs.length,
      findingUnitCount: sourcePack.units.filter((unit) => unit.sourceKind === "finding").length,
      todoUnitCount: sourcePack.units.filter((unit) => unit.sourceKind === "todo").length });
    if (sourcePack.units.length === 0) {
      return await notSupported("weekly_qa_no_relevant_sources");
    }
    if (!input.answerer || !input.verifier) {
      throw new WorkWeeklyQaTechnicalError("weekly_qa_provider_unavailable", stage);
    }
    const answerer = input.answerer;
    const verifier = input.verifier;
    stage = "answerer";
    stageStartedAt = performance.now();
    await emit({ stage, outcome: "started" });
    assertWorkWeeklyQaNotCancelled(input.signal);
    const draft = validateQaDraft(await answerer.answer({ sourcePack, signal: input.signal, onMetrics: captureMetrics }), sourcePack);
    assertWorkWeeklyQaNotCancelled(input.signal);
    await emit({ stage, outcome: "succeeded", claimCount: draft.claims.length });
    if (draft.status === "insufficient_evidence") {
      return await notSupported("weekly_qa_answerer_insufficient");
    }
    stage = "verifier";
    stageStartedAt = performance.now();
    metrics = {};
    await emit({ stage, outcome: "started", claimCount: draft.claims.length });
    assertWorkWeeklyQaNotCancelled(input.signal);
    const response = await verifier.verify({
      snapshot: input.snapshot,
      sourcePack,
      claims: draft.claims,
      signal: input.signal,
      onMetrics: captureMetrics
    });
    assertWorkWeeklyQaNotCancelled(input.signal);
    const parsed = WorkWeeklyVerifierResponseSchema.safeParse({ items: response });
    if (!parsed.success) throw new WorkWeeklyQaTechnicalError("weekly_qa_verifier_invalid", stage, parsed.error);
    const verdicts = validateWorkWeeklyVerifierOutput({ response: parsed.data, claims: draft.claims });
    await emit({ stage, outcome: "succeeded", verdictCount: verdicts.length,
      verdictCounts: workWeeklyQaReasonCounts(verdicts.map((verdict) => verdict.verdict)),
      issueCounts: workWeeklyQaReasonCounts(verdicts.flatMap((verdict) => verdict.issueCodes)) });
    stage = "publication";
    stageStartedAt = performance.now();
    let publicationReasons: string[] = [];
    let publishedClaimCount = 0;
    let publishedClaimIds = new Set<string>();
    const published = applyWorkWeeklyClaimPublicationPolicy({
      snapshot: input.snapshot,
      items: [{
        id: "qa_answer",
        section: "overview",
        itemType: "evidence_backed_fact",
        text: draft.answer || "QA answer",
        claims: draft.claims
      }],
      verdicts,
      onClaims: (claims) => {
        publicationReasons = claims.map((claim) => claim.reasonCode);
        publishedClaimCount = claims.filter((claim) => claim.outcome === "published" || claim.outcome === "merged").length;
        publishedClaimIds = new Set(claims.filter((claim) => claim.outcome === "published").map((claim) => claim.claimId));
      }
    });
    if (publicationReasons.some((reason) => reason === "invalid_contract" || reason === "item_output_invalid")) {
      throw new WorkWeeklyQaTechnicalError("weekly_qa_publication_invalid", stage);
    }
    await emit({ stage, outcome: "succeeded", publishedClaimCount,
      publicationReasonCounts: workWeeklyQaReasonCounts(publicationReasons) });
    if (published.length === 0) {
      return await notSupported("weekly_qa_no_safe_claims");
    }
    const item = published[0]!;
    const paragraphs = draft.claims.filter((claim) => publishedClaimIds.has(claim.id)).map((claim) => claim.text);
    // Format only the policy's exact surviving text. Related-claim suppression,
    // duplicate merging and the verified citation union remain the policy's work.
    const answer = paragraphs.join("；") === item.text ? paragraphs.join("\n\n") : item.text;
    const partial = draft.status === "partially_answered"
      || publishedClaimCount < draft.claims.length
      || item.verificationState === "qualified"
      || verdicts.some((verdict) => verdict.verdict !== "entailed");
    return {
      answerStatus: partial ? "partially_answered" : "answered",
      answer,
      sourceRefs: item.sourceRefs,
      providerProfile: answerer.profile.id,
      promptVersion: answerer.profile.promptVersion,
      verifierProfile: verifier.profile.id,
      failureCode: null
    };
  } catch (error) {
    const failure = classifyWorkWeeklyQaError(error, stage);
    await emit({ stage, outcome: "failed", errorCode: failure.code, schemaIssues: workWeeklyQaSchemaIssues(failure) });
    throw failure;
  }
}

export const WORK_WEEKLY_QA_SCHEMA_NAMES = {
  answerer: WORK_WEEKLY_QA_ANSWERER_SCHEMA_VERSION,
  verifier: WORK_WEEKLY_QA_VERIFIER_SCHEMA_VERSION
} as const;
