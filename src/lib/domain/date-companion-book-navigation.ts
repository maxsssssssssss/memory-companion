const PREPARE_PATH = "/date-companion/a/prepare";
const LOCAL_ORIGIN = "http://book-navigation.invalid";

/** Retire presentation flags while keeping the old preparation-records link. */
export function canonicalCompanionPath(url: URL): string {
  if (url.pathname === PREPARE_PATH && url.searchParams.get("view") === "records" && !url.searchParams.has("section"))
    url.searchParams.set("section", "records");
  url.searchParams.delete("view");
  if (url.searchParams.get("from") === "book-home") url.searchParams.delete("from");
  return url.pathname + url.search + url.hash;
}

/** undefined means the regular latest-discussion entry; null is an intentional
 * unsent new-discussion draft. A real ID wins while the URL binds a first send. */
export function preparationDiscussionFromQuery(preparation: unknown, draft: unknown): string | null | undefined {
  if (typeof preparation === "string" && preparation.trim()) return preparation.trim();
  return draft === "new" ? null : undefined;
}

/** Accept only the local preparation route, never an arbitrary redirect target. */
export function safePreparationReturnTo(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || /[\\\r\n]/u.test(value)) return null;
  try {
    const url = new URL(value, LOCAL_ORIGIN);
    return url.origin === LOCAL_ORIGIN && url.pathname === PREPARE_PATH
      ? canonicalCompanionPath(url) : null;
  } catch { return null; }
}

export function bookPreparationHref(discussionId?: string | null) {
  return discussionId ? `${PREPARE_PATH}?${new URLSearchParams({ preparation: discussionId })}` : PREPARE_PATH;
}

export function bookPersonHref(personId?: string | null, section?: "directory" | "manage" | "records") {
  const path = "/date-companion/a/people" + (personId ? "/" + encodeURIComponent(personId) : "");
  return section ? path + "?" + new URLSearchParams({ section }) : path;
}

/** Only the current person's book can be the origin of a relationship recap. */
export function safePersonReturnTo(value: unknown, confirmedPersonId: string | null, singlePersonId: string | null = null): string | null {
  if (!confirmedPersonId || typeof value !== "string" || !value.startsWith("/") ||
    value.startsWith("//") || /[\\\r\n]/u.test(value)) return null;
  try {
    const url = new URL(value, LOCAL_ORIGIN);
    const permitted = ["/date-companion/a/person", "/date-companion/a/people/" + encodeURIComponent(confirmedPersonId)];
    // Preserve the actual reading-point URL only while the directory still
    // resolves to this same verified person; a real directory is not an origin.
    if (singlePersonId === confirmedPersonId && !url.searchParams.has("section")) permitted.push("/date-companion/a/people");
    return url.origin === LOCAL_ORIGIN && permitted.includes(url.pathname) ? canonicalCompanionPath(url) : null;
  } catch { return null; }
}
