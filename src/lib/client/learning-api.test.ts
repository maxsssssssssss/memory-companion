import { afterEach, expect, it, vi } from "vitest";
import { learningApi, LearningApiError, learningErrorMessage, LEARNING_INVALIDATION_CHANNEL } from "./learning-api";

afterEach(() => vi.unstubAllGlobals());

it("invalidates other learning tabs only after a confirmed quiz deletion", async () => {
  const messages: unknown[] = [], close = vi.fn();
  vi.stubGlobal("BroadcastChannel", class {
    constructor(name: string) { expect(name).toBe(LEARNING_INVALIDATION_CHANNEL); }
    postMessage(message: unknown) { messages.push(message); }
    close = close;
  });
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ quizzes: [] }), { status: 200 }));
  vi.stubGlobal("fetch", fetcher);
  expect(await learningApi.deleteQuiz("synthetic-page", "synthetic-quiz")).toEqual({ quizzes: [] });
  expect(fetcher).toHaveBeenCalledWith("/api/learning/pages/synthetic-page/quiz", expect.objectContaining({
    method: "DELETE", credentials: "same-origin", cache: "no-store", body: JSON.stringify({ id: "synthetic-quiz" })
  }));
  expect(messages).toEqual([{ pageId: "synthetic-page" }]); expect(close).toHaveBeenCalledTimes(1);
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ error: "learning_storage_unavailable" }), { status: 503 }));
  await expect(learningApi.deleteQuiz("synthetic-page", "synthetic-quiz")).rejects.toEqual(new LearningApiError(503, "learning_storage_unavailable"));
  expect(messages).toHaveLength(1);
});

it("deletes successfully in browsers without BroadcastChannel", async () => {
  vi.stubGlobal("BroadcastChannel", undefined);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ quizzes: [] }), { status: 200 })));
  expect(await learningApi.deleteQuiz("synthetic-page", "synthetic-quiz")).toEqual({ quizzes: [] });
});

it("explains an unavailable OCR handshake without calling it an unknown submitted result",()=>{
  const message=learningErrorMessage(new LearningApiError(503,"pdf_parser_unavailable"));
  expect(message).toContain("尚未提交解析");expect(message).toContain("保留");
  expect(message).not.toContain("结果不明");
});
