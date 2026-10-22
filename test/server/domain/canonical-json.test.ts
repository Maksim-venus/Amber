import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../../src/server/domain/canonical-json.ts";

describe("canonicalJson", () => {
  it("sorts keys at every depth, keeps array order and drops undefined members", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: undefined } })).toBe('{"a":{"d":[3,{"y":2,"z":1}]},"b":1}');
    expect(canonicalJson([2, 1])).toBe("[2,1]");
    expect(canonicalJson("x")).toBe('"x"');
  });
});
