import { describe, expect, it, vi } from "vitest";

import type { WorkWeeklyQaMessage } from "@/lib/domain/work-weekly";

import {
  WORK_WEEKLY_QA_INSUFFICIENT_ANSWER,
  answerWorkWeeklyQuestion,
  buildWorkWeeklyQaSourcePack,
  createStructuredWorkWeeklyQaAnswerer
} from "./weekly-qa-provider";
import {
  WORK_WEEKLY_TEST_REFS,
  workWeeklyProfile,
  workWeeklyTestSnapshot
} from "./weekly-ai-test-fixture";

function message(input: Partial<WorkWeeklyQaMessage> & Pick<WorkWeeklyQaMessage, "id" | "role" | "text">): WorkWeeklyQaMessage {
  const snapshot = workWeeklyTestSnapshot();
  return {
    accountId: "account_a",
    weeklyReviewId: "weekly_a",
    threadId: "thread_a",
    answerStatus: input.role === "assistant" ? "answered" : null,
    sourceRefs: [],
    sourceSnapshotDigest: snapshot.digest,
    providerProfile: input.role === "assistant" ? "test" : null,
    promptVersion: input.role === "assistant" ? "test" : null,
    verifierProfile: input.role === "assistant" ? "test" : null,
    version: 1,
    createdAt: "2026-09-03T08:00:00.000Z",
    invalidatedAt: null,
    ...input
  };
}

describe("Work Weekly QA", () => {
  it.each([
    "谁应该被晋升？", "应该提拔哪位同事？", "成员甲值得升职吗？",
    "某人是否负责？", "成员甲是不是一个负责任的人？", "谁该为延期承担责任？",
    "这次失败应该归咎于谁？", "项目延期是谁的错？", "谁应该背锅？",
    "谁工作最多？", "哪位同事效率最低？", "给团队成员按贡献排序",
    "按本周工作表现给员工打分", "成员甲的工作能力怎么样？", "人员绩效排名是什么？",
    "团队士气如何？", "成员甲是不是在偷懒？", "某人的心理状态怎样？",
    "成员甲内心是否抵触这个决定？", "成员甲是否故意拖延？",
    "谁 应该 被 晋升？", "某人\n是否\n负责？",
    "Who should be promoted?", "Does employee A deserve a promotion?",
    "Is employee A responsible?", "Who is to blame for the delay?",
    "Rank team members by performance.", "Which employee contributes the most?",
    "Is employee A lazy?", "What is the team's morale?"
  ])("refuses personnel assessment before either Provider call: %s", async (question) => {
    const answerer = vi.fn();
    const verifier = vi.fn();
    // Ordinary confirmed work records do not authorize personnel judgments.
    const answer = await answerWorkWeeklyQuestion({
      accountId: "account_a", weeklyReviewId: "weekly_a",
      snapshot: workWeeklyTestSnapshot(), question,
      answerer: { profile: workWeeklyProfile("qa_answerer"), answer: answerer },
      verifier: { profile: workWeeklyProfile("qa_verifier"), verify: verifier }
    });
    expect(answer).toMatchObject({
      answerStatus: "insufficient_evidence", sourceRefs: [],
      answer: WORK_WEEKLY_QA_INSUFFICIENT_ANSWER,
      failureCode: "weekly_qa_performance_question_refused"
    });
    expect(answerer).not.toHaveBeenCalled();
    expect(verifier).not.toHaveBeenCalled();
  });

  it.each([
    "本周项目进度如何？", "本周决定采用哪个方案？", "本周系统效率如何？",
    "本周有哪些待办？", "本周谁负责检查发布清单？", "Sam 是否负责检查发布清单？"
  ])("keeps ordinary project and recorded task ownership QA available: %s", async (question) => {
    const claim = {
      id: "claim_commitment", text: "已记录的发布清单承诺", claimType: "commitment" as const,
      sourceRefs: [WORK_WEEKLY_TEST_REFS.commitment]
    };
    const answerer = vi.fn(async () => ({
      status: "answered" as const, answer: "fixture", claims: [claim],
      relevantSourceRefs: claim.sourceRefs
    }));
    const verifier = vi.fn(async () => [{
      claimId: claim.id, verdict: "entailed" as const, issueCodes: [],
      supportedSourceRefs: claim.sourceRefs
    }]);
    const answer = await answerWorkWeeklyQuestion({
      accountId: "account_a", weeklyReviewId: "weekly_a",
      snapshot: workWeeklyTestSnapshot(), question,
      answerer: { profile: workWeeklyProfile("qa_answerer"), answer: answerer },
      verifier: { profile: workWeeklyProfile("qa_verifier"), verify: verifier }
    });
    expect(answer.answerStatus).toBe("answered");
    expect(answer.failureCode).toBeNull();
    expect(answerer).toHaveBeenCalledTimes(1);
    expect(verifier).toHaveBeenCalledTimes(1);
  });

  it("keeps prior answers only as current-snapshot conversation context, never Evidence", () => {
    const snapshot = workWeeklyTestSnapshot();
    const pack = buildWorkWeeklyQaSourcePack({
      accountId: "account_a",
      weeklyReviewId: "weekly_a",
      snapshot,
      question: "本周最终决定了什么？",
      history: [
        message({ id: "user_1", role: "user", text: "先说决定" }),
        message({ id: "assistant_current", role: "assistant", text: "旧回答自由文字" }),
        message({ id: "assistant_invalid", role: "assistant", text: "已失效回答", invalidatedAt: "2026-09-03T09:00:00.000Z" }),
        message({ id: "assistant_stale", role: "assistant", text: "旧快照回答", sourceSnapshotDigest: "9".repeat(64) })
      ]
    });
    expect(pack.history.recentMessages.map((entry) => entry.text)).toContain("旧回答自由文字");
    expect(pack.history.recentMessages.map((entry) => entry.text)).not.toContain("已失效回答");
    expect(pack.history.recentMessages.map((entry) => entry.text)).not.toContain("旧快照回答");
    expect(JSON.stringify(pack.units)).not.toContain("旧回答自由文字");
    expect(pack.allowlistedSourceRefs).not.toContain("assistant_current");
  });

  it("publishes only the verifier-backed canonical decision, not Answerer prose", async () => {
    const answer = await answerWorkWeeklyQuestion({
      accountId: "account_a",
      weeklyReviewId: "weekly_a",
      snapshot: workWeeklyTestSnapshot(),
      question: "本周最终决定了什么？",
      answerer: {
        profile: workWeeklyProfile("qa_answerer"),
        answer: vi.fn(async () => ({
          status: "answered" as const,
          answer: "模型说方案 C 已经决定了",
          claims: [{
            id: "claim_decision",
            text: "选择方案 B",
            claimType: "decision" as const,
            sourceRefs: [WORK_WEEKLY_TEST_REFS.decision]
          }],
          relevantSourceRefs: [WORK_WEEKLY_TEST_REFS.decision]
        }))
      },
      verifier: {
        profile: workWeeklyProfile("qa_verifier"),
        verify: vi.fn(async () => [{
          claimId: "claim_decision",
          verdict: "entailed" as const,
          issueCodes: [],
          supportedSourceRefs: [WORK_WEEKLY_TEST_REFS.decision]
        }])
      }
    });
    expect(answer.answerStatus).toBe("answered");
    expect(answer.answer).toBe("选择方案 B");
    expect(answer.answer).not.toContain("方案 C");
    expect(answer.sourceRefs).toEqual([WORK_WEEKLY_TEST_REFS.decision]);
  });

  it("describes Todo completion only as a system state", async () => {
    const answer = await answerWorkWeeklyQuestion({
      accountId: "account_a",
      weeklyReviewId: "weekly_a",
      snapshot: workWeeklyTestSnapshot(),
      question: "本周完成了什么？",
      answerer: {
        profile: workWeeklyProfile("qa_answerer"),
        answer: vi.fn(async () => ({
          status: "answered" as const,
          answer: "已经现实履行",
          claims: [{ id: "claim_completion", text: "清单在系统中标记完成。", claimType: "completion" as const, sourceRefs: [WORK_WEEKLY_TEST_REFS.todoCompleted] }],
          relevantSourceRefs: [WORK_WEEKLY_TEST_REFS.todoCompleted]
        }))
      },
      verifier: {
        profile: workWeeklyProfile("qa_verifier"),
        verify: vi.fn(async () => [{ claimId: "claim_completion", verdict: "entailed" as const, issueCodes: [], supportedSourceRefs: [WORK_WEEKLY_TEST_REFS.todoCompleted] }])
      }
    });
    expect(answer.answer).toContain("在系统中标记完成");
    expect(answer.answer).not.toContain("现实履行");
  });

  it("uses a short fail-closed answer when no relevant source exists and calls GPT zero times", async () => {
    const answerer = vi.fn();
    const verifier = vi.fn();
    const answer = await answerWorkWeeklyQuestion({
      accountId: "account_a",
      weeklyReviewId: "weekly_a",
      snapshot: workWeeklyTestSnapshot(),
      question: "明天上海天气怎么样？",
      answerer: { profile: workWeeklyProfile("qa_answerer"), answer: answerer },
      verifier: { profile: workWeeklyProfile("qa_verifier"), verify: verifier }
    });
    expect(answer).toMatchObject({
      answerStatus: "insufficient_evidence",
      answer: WORK_WEEKLY_QA_INSUFFICIENT_ANSWER,
      sourceRefs: []
    });
    expect(answerer).not.toHaveBeenCalled();
    expect(verifier).not.toHaveBeenCalled();
  });

  it("does not call the Answerer when the independent verifier is unavailable", async () => {
    const answerer = vi.fn();
    await expect(answerWorkWeeklyQuestion({
      accountId: "account_a",
      weeklyReviewId: "weekly_a",
      snapshot: workWeeklyTestSnapshot(),
      question: "本周决定了什么？",
      answerer: { profile: workWeeklyProfile("qa_answerer"), answer: answerer },
      verifier: null
    })).rejects.toMatchObject({ code: "weekly_qa_provider_unavailable" });
    expect(answerer).not.toHaveBeenCalled();
  });

  it("rejects a fabricated Answerer sourceRef before verification", async () => {
    const verifier = vi.fn();
    const answerer = createStructuredWorkWeeklyQaAnswerer({
      profile: workWeeklyProfile("qa_answerer"),
      requestStructuredJson: vi.fn(async () => ({
        status: "answered",
        answer: "伪造",
        claims: [{ id: "claim_bad", text: "伪造", claimType: "fact", sourceRefs: ["work:evidence:foreign"] }],
        relevantSourceRefs: ["work:evidence:foreign"]
      }))
    });
    await expect(answerWorkWeeklyQuestion({
      accountId: "account_a",
      weeklyReviewId: "weekly_a",
      snapshot: workWeeklyTestSnapshot(),
      question: "本周决定了什么？",
      answerer,
      verifier: { profile: workWeeklyProfile("qa_verifier"), verify: verifier }
    })).rejects.toMatchObject({ code: "weekly_qa_source_not_allowlisted" });
    expect(verifier).not.toHaveBeenCalled();
  });

  it("rejects Provider quote fields instead of treating model text as a citation", async () => {
    const verifier = vi.fn();
    const answerer = createStructuredWorkWeeklyQaAnswerer({
      profile: workWeeklyProfile("qa_answerer"),
      requestStructuredJson: vi.fn(async () => ({
        status: "answered",
        answer: "回答",
        claims: [{
          id: "claim_decision", text: "方案 B", claimType: "decision",
          sourceRefs: [WORK_WEEKLY_TEST_REFS.decision], quote: "模型伪造原话"
        }],
        relevantSourceRefs: [WORK_WEEKLY_TEST_REFS.decision]
      }))
    });
    await expect(answerWorkWeeklyQuestion({
      accountId: "account_a",
      weeklyReviewId: "weekly_a",
      snapshot: workWeeklyTestSnapshot(),
      question: "本周决定了什么？",
      answerer,
      verifier: { profile: workWeeklyProfile("qa_verifier"), verify: verifier }
    })).rejects.toMatchObject({ code: "weekly_qa_answer_invalid" });
    expect(verifier).not.toHaveBeenCalled();
  });

  it("rejects cross-account scope before any Provider call", async () => {
    const answerer = vi.fn();
    await expect(answerWorkWeeklyQuestion({
      accountId: "account_b",
      weeklyReviewId: "weekly_a",
      snapshot: workWeeklyTestSnapshot(),
      question: "本周决定了什么？",
      answerer: { profile: workWeeklyProfile("qa_answerer"), answer: answerer },
      verifier: null
    })).rejects.toThrow();
    expect(answerer).not.toHaveBeenCalled();
  });
});
