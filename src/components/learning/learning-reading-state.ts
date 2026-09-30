"use client";

import { createContext, useContext } from "react";

/** The authenticated Shell supplies identity; browser preferences never authorize data access. */
export const LearningReadingAccount = createContext<string | undefined>(undefined);
export const learningReadingKey = (accountId: string, pageId: string) =>
  `daily-brief:${encodeURIComponent(accountId)}:learning:${encodeURIComponent(pageId)}:reading-v1`;
export function useLearningReadingKey(pageId: string) {
  const accountId = useContext(LearningReadingAccount);
  return accountId ? learningReadingKey(accountId, pageId) : undefined;
}

export type MindMapReadingState = {
  zoom: number; expanded: string[]; rootOpen: boolean; relationsOpen: boolean; left: number; top: number;
};
export type ReadingPosition = { chapterId: string; nodeId?: string; section?: "map"; offset: number };
export type LearningReadingState = { position?: ReadingPosition; mapOpen?: boolean; map?: MindMapReadingState };
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
// Ignore queued preference writes from components unmounting after a confirmed page deletion.
const deletedPages = new Set<string>();

// Whitelist only view coordinates and IDs. Never cache source text, drafts, notes or access URLs.
function sanitize(value: unknown): LearningReadingState {
  if (!value || typeof value !== "object") return {};
  const raw = value as LearningReadingState, result: LearningReadingState = {};
  if (typeof raw.mapOpen === "boolean") result.mapOpen = raw.mapOpen;
  const position = raw.position;
  if (position && id(position.chapterId) && finite(position.offset)) result.position = {
    chapterId: position.chapterId, offset: Math.max(-1_000_000, Math.min(1_000_000, position.offset)),
    ...(id(position.nodeId) ? { nodeId: position.nodeId } : {}), ...(position.section === "map" ? { section: "map" as const } : {}),
  };
  const map = raw.map;
  if (map && finite(map.zoom) && finite(map.left) && finite(map.top) && Array.isArray(map.expanded)
    && typeof map.rootOpen === "boolean" && typeof map.relationsOpen === "boolean") result.map = {
    zoom: Math.max(0.5, Math.min(2, map.zoom)), left: Math.max(0, Math.min(1_000_000, map.left)),
    top: Math.max(0, Math.min(1_000_000, map.top)), expanded: [...new Set(map.expanded.filter(id))].slice(0, 2000),
    rootOpen: map.rootOpen, relationsOpen: map.relationsOpen,
  };
  return result;
}

export function readLearningReadingState(key?: string): LearningReadingState {
  if (!key) return {};
  try { return sanitize(JSON.parse(window.localStorage.getItem(key) ?? "null")); } catch { return {}; }
}
export function saveLearningReadingState(key: string | undefined, patch: LearningReadingState) {
  if (!key || deletedPages.has(key)) return;
  try { window.localStorage.setItem(key, JSON.stringify(sanitize({ ...readLearningReadingState(key), ...patch }))); } catch { /* Reading works without browser storage. */ }
}
export function clearLearningReadingState(key?: string) {
  if (!key) return;
  deletedPages.add(key);
  try { window.localStorage.removeItem(key); } catch { /* Browser preferences are optional. */ }
}
