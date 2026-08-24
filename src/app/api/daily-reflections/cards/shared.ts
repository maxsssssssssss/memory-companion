import { NextResponse } from "next/server";

import {
  DailyReflectionWorkingCardDetailResponseSchema,
  DailyReflectionWorkingCardListResponseSchema
} from "@/lib/domain/daily-reflection-api";
import type { DailyReflectionWorkingCard } from "@/lib/domain/daily-reflection-working-card";
import {
  DailyReflectionConflictError,
  DailyReflectionNotFoundError,
  DailyReflectionVersionConflictError
} from "@/lib/server/daily-reflection";

export function workingCardDetailResponse(input: {
  card: DailyReflectionWorkingCard;
  evidence: unknown[];
}) {
  const { accountId: _accountId, ...card } = input.card;
  return DailyReflectionWorkingCardDetailResponseSchema.parse({
    card: { ...card, evidence: input.evidence }
  });
}

export function workingCardListResponse(input: {
  cards: DailyReflectionWorkingCard[];
  total: number;
  limit: number;
  offset: number;
}) {
  return DailyReflectionWorkingCardListResponseSchema.parse({
    ...input,
    cards: input.cards.map(({ accountId: _accountId, ...card }) => card)
  });
}

export function workingCardRouteError(error: unknown): NextResponse {
  if (error instanceof DailyReflectionNotFoundError) {
    return NextResponse.json({ error: "daily_reflection_working_card_not_found" }, { status: 404 });
  }
  if (error instanceof DailyReflectionVersionConflictError) {
    return NextResponse.json(
      { error: "version_conflict", currentVersion: error.currentVersion },
      { status: 409 }
    );
  }
  if (error instanceof DailyReflectionConflictError) {
    return NextResponse.json({ error: error.code }, { status: 409 });
  }
  throw error;
}
