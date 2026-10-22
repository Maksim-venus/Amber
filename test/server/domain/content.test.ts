import { describe, expect, it } from "vitest";
import { platformContentKey } from "../../../src/server/domain/content.ts";

describe("platformContentKey", () => {
  it("identifies platform content by user, platform, content id and part id", () => {
    const part1 = platformContentKey("u1", { kind: "bilibili", platformContentId: "BV1", platformPartId: "cid1" });
    const part2 = platformContentKey("u1", { kind: "bilibili", platformContentId: "BV1", platformPartId: "cid2" });
    const otherUser = platformContentKey("u2", { kind: "bilibili", platformContentId: "BV1", platformPartId: "cid1" });
    expect(new Set([part1, part2, otherUser]).size).toBe(3);
    expect(platformContentKey("u1", { kind: "bilibili", platformContentId: "BV1", platformPartId: "cid1" })).toBe(part1);
  });

  it("treats a missing part id as the empty part", () => {
    expect(platformContentKey("u1", { kind: "youtube", platformContentId: "v" })).toBe(
      platformContentKey("u1", { kind: "youtube", platformContentId: "v", platformPartId: "" }),
    );
  });

  it("gives local files no canonical key", () => {
    expect(platformContentKey("u1", { kind: "local" })).toBeNull();
  });
});
