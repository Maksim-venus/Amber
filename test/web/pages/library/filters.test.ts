import { describe, expect, it } from "vitest";
import { collectionChoiceOf, filtersFromSearch, UNCOLLECTED_CHOICE, withCollectionChoice, withFilter } from "../../../../src/web/pages/library/filters.ts";

describe("library filters", () => {
  it("reads known filters and ignores values the API would reject", () => {
    const search = new URLSearchParams("status=failed&source=nope&collectionId=c1&importBatchId=b1&tab=x");
    expect(filtersFromSearch(search)).toEqual({ status: "failed", collectionId: "c1", importBatchId: "b1" });
  });

  it("writes one filter and keeps the rest; empty removes it", () => {
    const search = new URLSearchParams("status=failed&importBatchId=b1");
    expect(withFilter(search, "source", "youtube").toString()).toBe("status=failed&importBatchId=b1&source=youtube");
    expect(withFilter(search, "importBatchId", "").toString()).toBe("status=failed");
    expect(search.toString()).toBe("status=failed&importBatchId=b1");
  });

  it("reads and writes 「未加入合集」 as the collection choice; a named collection wins", () => {
    expect(filtersFromSearch(new URLSearchParams("uncollected=1"))).toEqual({ uncollected: true });
    expect(filtersFromSearch(new URLSearchParams("uncollected=1&collectionId=c1"))).toEqual({ collectionId: "c1" });
    expect(collectionChoiceOf({ uncollected: true })).toBe(UNCOLLECTED_CHOICE);
    expect(collectionChoiceOf({ collectionId: "c1" })).toBe("c1");
    const search = new URLSearchParams("status=failed&collectionId=c1");
    expect(withCollectionChoice(search, UNCOLLECTED_CHOICE).toString()).toBe("status=failed&uncollected=1");
    expect(withCollectionChoice(new URLSearchParams("uncollected=1"), "c2").toString()).toBe("collectionId=c2");
    expect(withCollectionChoice(new URLSearchParams("uncollected=1"), "").toString()).toBe("");
  });

  it("goes back to page 1 when a filter changes, keeping the page size", () => {
    const search = new URLSearchParams("status=failed&page=3&pageSize=20");
    expect(withFilter(search, "source", "youtube").toString()).toBe("status=failed&pageSize=20&source=youtube");
    expect(withFilter(search, "status", "").toString()).toBe("pageSize=20");
    expect(withCollectionChoice(search, UNCOLLECTED_CHOICE).toString()).toBe("status=failed&pageSize=20&uncollected=1");
    expect(withCollectionChoice(search, "c1").toString()).toBe("status=failed&pageSize=20&collectionId=c1");
    expect(search.toString()).toBe("status=failed&page=3&pageSize=20");
  });
});
