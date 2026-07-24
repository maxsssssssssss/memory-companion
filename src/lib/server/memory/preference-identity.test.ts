// @vitest-environment node

import { describe, expect, it } from "vitest";
import { extractPreferenceIdentities } from "./preference-identity";

describe("preference identity", () => {
  it.each(["我不喜欢香菜。", "我不吃香菜。", "我不爱香菜。"])(
    "normalizes equivalent negative preference phrasing: %s",
    (text) => {
      expect(extractPreferenceIdentities(text)).toEqual([
        { key: "香菜", value: "avoid", fingerprint: "avoid\u001f香菜" }
      ]);
    }
  );

  it("keeps different preference keys separate", () => {
    expect(extractPreferenceIdentities("我不喜欢香菜，我更喜欢安静的位置。")).toEqual([
      { key: "香菜", value: "avoid", fingerprint: "avoid\u001f香菜" },
      { key: "安静的位置", value: "prefer", fingerprint: "prefer\u001f安静的位置" }
    ]);
  });

  it("does not invent an identity for a preference preface or one-time choice", () => {
    expect(extractPreferenceIdentities("我先把几个一直没变的饮食习惯说清楚。")).toEqual([]);
    expect(extractPreferenceIdentities("今天先喝拿铁吧。")).toEqual([]);
  });
});
