import { describe, expect, it } from "vitest";
import { bookPersonHref, bookPreparationHref, preparationDiscussionFromQuery, safePersonReturnTo, safePreparationReturnTo } from "./date-companion-book-navigation";

describe("book preparation return paths", () => {
  it("distinguishes a new draft from latest history and lets a bound real ID win", () => {
    expect(preparationDiscussionFromQuery(null, "new")).toBeNull();
    expect(preparationDiscussionFromQuery(undefined, undefined)).toBeUndefined();
    expect(preparationDiscussionFromQuery("  ", "new")).toBeNull();
    expect(preparationDiscussionFromQuery(" actual-id ", "new")).toBe("actual-id");
    expect(preparationDiscussionFromQuery(["one", "two"], ["new"])).toBeUndefined();
  });
  it("retains the same discussion and canonicalizes retired presentation flags", () => {
    const path = bookPreparationHref("discussion with spaces");
    expect(safePreparationReturnTo(path)).toBe(path);
    expect(bookPreparationHref()).toBe("/date-companion/a/prepare");
    expect(safePreparationReturnTo("/date-companion/a/prepare?view=classic&from=book-home&preparation=same-id#paper"))
      .toBe("/date-companion/a/prepare?preparation=same-id#paper");
    expect(safePreparationReturnTo("/date-companion/a/prepare?view=records&from=book-home"))
      .toBe("/date-companion/a/prepare?section=records");
  });
  it.each([undefined, "https://example.com/date-companion/a/prepare", "//example.com/date-companion/a/prepare", "/\\example.com/date-companion/a/prepare", "/date-companion/a/prepare/extra", "/date-companion/a/person", "/date-companion/a/prepare\n?view=book"])("rejects unsafe or unrelated paths: %s", value => {
    expect(safePreparationReturnTo(value)).toBeNull();
  });
});

describe("book person return paths", () => {
  it("keeps the archive filter and the permitted person", () => {
    const path = bookPersonHref("confirmed-Ta") + "?section=archive&filter=meeting";
    expect(safePersonReturnTo(path, "confirmed-Ta")).toBe(path);
    expect(safePersonReturnTo(path + "&view=classic&from=book-home", "confirmed-Ta")).toBe(path);
    expect(safePersonReturnTo(path, "another-person")).toBeNull();
    expect(safePersonReturnTo(path, null)).toBeNull();
  });
  it("preserves a sole-person alias only while it still resolves to the confirmed person", () => {
    const path = bookPersonHref();
    expect(safePersonReturnTo(path, "confirmed-Ta", "confirmed-Ta")).toBe(path);
    expect(safePersonReturnTo(path, "confirmed-Ta")).toBeNull();
    expect(safePersonReturnTo(path, "confirmed-Ta", "another-person")).toBeNull();
    expect(safePersonReturnTo(path, null, "confirmed-Ta")).toBeNull();
    for (const section of ["directory", "manage", "records", "archive"]) {
      expect(safePersonReturnTo(path + "?section=" + section, "confirmed-Ta", "confirmed-Ta")).toBeNull();
    }
    expect(safePersonReturnTo("/date-companion/a/people?view=classic", "confirmed-Ta", "confirmed-Ta")).toBe(path);
  });
  it.each(["https://example.com/date-companion/a/person", "//example.com/date-companion/a/person",
    "/date-companion/a/prepare", "/date-companion/a/people/other?view=classic"])("rejects %s", path => {
    expect(safePersonReturnTo(path, "current")).toBeNull();
  });
});
