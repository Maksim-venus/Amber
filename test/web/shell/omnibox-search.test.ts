import { describe, expect, it } from "vitest";
import type { CollectionDto } from "../../../src/shared/dto/collection.ts";
import type { ContentDto } from "../../../src/shared/dto/content.ts";
import { parseOmniboxQuery, recentItems } from "../../../src/web/shell/omnibox-search.ts";

const content = (id: string, title?: string): ContentDto => ({
  id,
  source: { kind: "youtube" },
  ...(title === undefined ? {} : { title }),
  processingStatus: "succeeded",
  collections: [],
  createdAt: 0,
  updatedAt: 0,
});
const collection = (id: string, name: string): CollectionDto => ({ id, name, itemCount: 0, createdAt: 0, updatedAt: 0 });

describe("omnibox search", () => {
  it("switches to command mode on the > prefix", () => {
    expect(parseOmniboxQuery("> 主题 ")).toEqual({ mode: "command", text: "主题" });
    expect(parseOmniboxQuery("  检索")).toEqual({ mode: "search", text: "检索" });
  });

  it("lists recent items as loaded, up to the limit", () => {
    const recent = recentItems([content("1"), content("2", "b"), content("3")], [collection("c", "课程")], 2);
    expect(recent.contents.map((item) => item.id)).toEqual(["1", "2"]);
    expect(recent.collections.map((item) => item.id)).toEqual(["c"]);
  });
});
