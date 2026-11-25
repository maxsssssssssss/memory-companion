type Direction = "forward" | "backward" | "none";
export type QaDraft = { text: string; start: number; end: number; direction: Direction };
export const emptyQaDraft: QaDraft = { text: "", start: 0, end: 0, direction: "none" };
const prefix = "dailybrief.qa-paper.draft.v1/";
const activeAccountKey = "dailybrief.qa-paper.active-account";
const memory = new Map<string, QaDraft>();

export function qaDraftKey(account: string, ...scope: (string | number)[]) {
  return prefix + [account, ...scope].map(value => encodeURIComponent(String(value))).join("/");
}

export function readQaDraft(key: string): QaDraft {
  const stored = memory.get(key);
  if (stored) return stored;
  try {
    const draft = JSON.parse(sessionStorage.getItem(key) || "null");
    if (draft && typeof draft.text === "string") {
      const clamp = (n: number) => Math.max(0, Math.min(draft.text.length, Math.floor(n) || 0));
      return { text: draft.text, start: clamp(draft.start), end: clamp(draft.end),
        direction: draft.direction === "backward" || draft.direction === "forward" ? draft.direction : "none" };
    }
  } catch { /* Storage may be unavailable in a private tab. */ }
  return emptyQaDraft;
}

export function writeQaDraft(key: string, draft: QaDraft) {
  if (draft.text) memory.set(key, draft);
  else memory.delete(key);
  try {
    if (draft.text) sessionStorage.setItem(key, JSON.stringify(draft));
    else sessionStorage.removeItem(key);
  } catch { /* Keep this tab's working copy. */ }
}

export function clearQaDrafts(account: string) {
  const accountPrefix = qaDraftKey(account) + "/";
  for (const key of memory.keys()) if (key.startsWith(accountPrefix)) memory.delete(key);
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const key = sessionStorage.key(i);
      if (key?.startsWith(accountPrefix)) sessionStorage.removeItem(key);
    }
    if (sessionStorage.getItem(activeAccountKey) === account) sessionStorage.removeItem(activeAccountKey);
  } catch { /* Scoped memory has already been cleared. */ }
}

export function activateQaDraftAccount(account: string) {
  try {
    const previous = sessionStorage.getItem(activeAccountKey);
    if (previous && previous !== account) clearQaDrafts(previous);
    sessionStorage.setItem(activeAccountKey, account);
  } catch { /* Account IDs are also part of all in-memory keys. */ }
}
