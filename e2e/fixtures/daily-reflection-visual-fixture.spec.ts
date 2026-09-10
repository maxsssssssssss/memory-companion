import { expect, test, type Page, type Route } from "@playwright/test";
import { z } from "zod";

import { AuthUserSchema } from "../../src/lib/client/date-companion-api";
import {
  DailyReflectionDetailResponseSchema,
  DailyReflectionHistoryResponseSchema,
  DailyReflectionWorkingCardDetailResponseSchema,
  DailyReflectionWorkingCardListResponseSchema
} from "../../src/lib/domain/daily-reflection-api";
import { DailyReflectionMemoryRecommendationResponseSchema } from "../../src/lib/domain/daily-reflection-memory-proposal";
import {
  DailyReflectionMemoryDetailResponseSchema,
  DailyReflectionMemoryListResponseSchema
} from "../../src/lib/domain/daily-reflection-memory-view";
import {
  DailyReflectionDailyReturnResponseSchema,
  DailyReflectionWeeklyReflectionResponseSchema
} from "../../src/lib/domain/daily-reflection-return";
import {
  createDailyReflectionVisualFixture,
  installDailyReflectionVisualFixture,
  resolveDailyReflectionVisualRequest,
  type DailyReflectionVisualFixture
} from "./daily-reflection-visual-fixture";

const AuthMeResponseSchema = z.object({ user: AuthUserSchema }).strict();

function parseEveryPayload(fixture: DailyReflectionVisualFixture) {
  return {
    auth: AuthMeResponseSchema.parse(fixture.auth),
    history: DailyReflectionHistoryResponseSchema.parse(fixture.history),
    detail: DailyReflectionDetailResponseSchema.parse(fixture.detail),
    recommendations: DailyReflectionMemoryRecommendationResponseSchema.parse(
      fixture.recommendations
    ),
    cardList: DailyReflectionWorkingCardListResponseSchema.parse(fixture.cardList),
    cardDetail: DailyReflectionWorkingCardDetailResponseSchema.parse(fixture.cardDetail),
    memoryList: DailyReflectionMemoryListResponseSchema.parse(fixture.memoryList),
    memoryDetail: DailyReflectionMemoryDetailResponseSchema.parse(fixture.memoryDetail),
    dailyReturn: DailyReflectionDailyReturnResponseSchema.parse(fixture.dailyReturn),
    weeklyReturn: DailyReflectionWeeklyReflectionResponseSchema.parse(fixture.weeklyReturn)
  };
}

test.describe("Daily Reflection visual fixture contract", () => {
  test("parses every populated payload with the formal runtime schemas", () => {
    const fixture = createDailyReflectionVisualFixture("populated");
    const parsed = parseEveryPayload(fixture);

    expect(parsed.history.reflections).toHaveLength(3);
    expect(parsed.detail.cards).toHaveLength(2);
    expect(parsed.recommendations.recommendations).toHaveLength(2);
    expect(parsed.cardList.cards).toHaveLength(4);
    expect(parsed.memoryList.memories).toHaveLength(2);
    expect(parsed.dailyReturn.openLoops).toHaveLength(1);
    expect(parsed.weeklyReturn.repeatedThemes).toHaveLength(1);
  });

  test("keeps empty collections schema-valid while preserving direct detail fixtures", () => {
    const fixture = createDailyReflectionVisualFixture("empty");
    const parsed = parseEveryPayload(fixture);

    expect(parsed.history.reflections).toEqual([]);
    expect(parsed.recommendations.recommendations).toEqual([]);
    expect(parsed.cardList).toMatchObject({ cards: [], total: 0 });
    expect(parsed.memoryList).toEqual({ memories: [], total: 0 });
    expect(parsed.dailyReturn).toMatchObject({
      openLoops: [],
      resurfacedMemories: [],
      reflectionPrompts: []
    });
    expect(parsed.weeklyReturn).toMatchObject({
      repeatedThemes: [],
      changedDecisions: [],
      openCommitments: [],
      emergingIdeas: []
    });
    expect(parsed.detail.reflection.id).toBe(fixture.ids.sessionReflectionId);
    expect(parsed.cardDetail.card.id).toBe(fixture.ids.insightCardId);
    expect(parsed.memoryDetail.memory.id).toBe(fixture.ids.decisionMemoryId);
  });

  test("keeps cross-route IDs and canonical sources coherent", () => {
    const fixture = createDailyReflectionVisualFixture("populated");
    const detailCardIds = new Set(fixture.detail.cards.map((card) => card.id));
    const libraryCardIds = new Set(fixture.cardList.cards.map((card) => card.id));
    const memoryIds = new Set(fixture.memoryList.memories.map((memory) => memory.id));

    for (const recommendation of fixture.recommendations.recommendations) {
      expect(detailCardIds.has(recommendation.cardId)).toBe(true);
      expect(libraryCardIds.has(recommendation.cardId)).toBe(true);
    }
    for (const memory of fixture.memoryList.memories) {
      expect(libraryCardIds.has(memory.cardId)).toBe(true);
    }
    for (const item of [
      ...fixture.dailyReturn.openLoops,
      ...fixture.dailyReturn.resurfacedMemories,
      ...fixture.dailyReturn.reflectionPrompts,
      ...fixture.weeklyReturn.repeatedThemes,
      ...fixture.weeklyReturn.changedDecisions,
      ...fixture.weeklyReturn.openCommitments
    ]) {
      for (const memoryId of item.sourceMemoryIds) expect(memoryIds.has(memoryId)).toBe(true);
      for (const cardId of item.sourceCardIds) expect(libraryCardIds.has(cardId)).toBe(true);
    }
  });

  test("rejects representative DTO drift through formal refinements", () => {
    const fixture = createDailyReflectionVisualFixture("populated");
    const badDetail = structuredClone(fixture.detail);
    badDetail.segments[0].text = "与 canonical Evidence 不一致";
    expect(() => DailyReflectionDetailResponseSchema.parse(badDetail)).toThrow();

    const badRecommendations = structuredClone(fixture.recommendations);
    badRecommendations.recommendations[1].rank = 4;
    expect(() => DailyReflectionMemoryRecommendationResponseSchema.parse(badRecommendations))
      .toThrow();

    const badMemoryList = structuredClone(fixture.memoryList);
    badMemoryList.total += 1;
    expect(() => DailyReflectionMemoryListResponseSchema.parse(badMemoryList)).toThrow();

    const badCardDetail = {
      ...structuredClone(fixture.cardDetail),
      unexpected: true
    };
    expect(() => DailyReflectionWorkingCardDetailResponseSchema.parse(badCardDetail)).toThrow();
  });

  test("matches known routes by exact method and pathname and fails unknown DR APIs closed", () => {
    const fixture = createDailyReflectionVisualFixture("populated");
    const cases = [
      ["/api/auth/me", fixture.auth],
      ["/api/daily-reflections", fixture.history],
      [`/api/daily-reflections/${fixture.ids.sessionReflectionId}`, fixture.detail],
      [
        `/api/daily-reflections/${fixture.ids.sessionReflectionId}/memory-recommendations`,
        fixture.recommendations
      ],
      ["/api/daily-reflections/cards?status=saved&limit=50", fixture.cardList],
      [`/api/daily-reflections/cards/${fixture.ids.insightCardId}`, fixture.cardDetail],
      ["/api/daily-reflections/memories", fixture.memoryList],
      [`/api/daily-reflections/memories/${fixture.ids.decisionMemoryId}`, fixture.memoryDetail],
      ["/api/daily-reflections/returns/daily?date=2026-08-24", fixture.dailyReturn],
      ["/api/daily-reflections/returns/weekly?endDate=2026-08-24", fixture.weeklyReturn]
    ] as const;

    for (const [url, expectedBody] of cases) {
      const resolution = resolveDailyReflectionVisualRequest(fixture, "GET", url);
      expect(resolution).toMatchObject({ action: "fulfill", status: 200 });
      if (resolution.action === "fulfill") expect(resolution.body).toBe(expectedBody);
    }

    expect(resolveDailyReflectionVisualRequest(
      fixture,
      "POST",
      `/api/daily-reflections/${fixture.ids.sessionReflectionId}`
    )).toMatchObject({
      action: "fulfill",
      method: "POST",
      status: 500
    });
    expect(resolveDailyReflectionVisualRequest(
      fixture,
      "GET",
      "/api/daily-reflections/unexpected/subroute"
    )).toMatchObject({
      action: "fulfill",
      pathname: "/api/daily-reflections/unexpected/subroute",
      status: 500
    });
    expect(resolveDailyReflectionVisualRequest(
      fixture,
      "GET",
      "/api/settings"
    )).toEqual({
      action: "continue",
      method: "GET",
      pathname: "/api/settings",
      status: null
    });
  });

  test("installs one Playwright API router, fulfills JSON, and records requests", async () => {
    let handler: ((route: Route) => Promise<void> | void) | undefined;
    let matcher: unknown;
    const page = {
      route: async (
        candidateMatcher: unknown,
        candidateHandler: (route: Route) => Promise<void> | void
      ) => {
        matcher = candidateMatcher;
        handler = candidateHandler;
      }
    } as unknown as Page;
    const controller = await installDailyReflectionVisualFixture(page);

    expect(matcher).toBe("**/api/**");
    expect(handler).toBeDefined();

    const fulfillCalls: Array<Parameters<Route["fulfill"]>[0]> = [];
    let continued = false;
    const route = {
      request: () => ({
        method: () => "GET",
        url: () => `http://127.0.0.1:3414/api/daily-reflections/${controller.fixture.ids.sessionReflectionId}`
      }),
      fulfill: async (options: Parameters<Route["fulfill"]>[0]) => {
        fulfillCalls.push(options);
      },
      continue: async () => {
        continued = true;
      }
    } as unknown as Route;
    await handler!(route);

    expect(continued).toBe(false);
    expect(fulfillCalls).toHaveLength(1);
    const fulfilled = fulfillCalls[0];
    if (!fulfilled) throw new Error("visual fixture did not fulfill the matched request");
    expect(fulfilled).toMatchObject({
      status: 200,
      contentType: "application/json",
      headers: { "Cache-Control": "private, no-store" }
    });
    expect(JSON.parse(String(fulfilled.body))).toEqual(controller.fixture.detail);
    expect(controller.requests).toEqual([{
      action: "fulfill",
      method: "GET",
      pathname: `/api/daily-reflections/${controller.fixture.ids.sessionReflectionId}`,
      status: 200
    }]);
  });
});
