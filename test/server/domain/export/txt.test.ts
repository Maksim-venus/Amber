import { describe, expect, it } from "vitest";
import { txtParagraph } from "../../../../src/server/domain/export/txt.ts";

describe("txtParagraph", () => {
  it("writes paragraphs separated by one blank line, without time stamps", () => {
    expect(txtParagraph({ startMs: 5000, text: "一" }, true) + txtParagraph({ startMs: 9000, text: "二" }, false)).toBe("一\n\n二\n");
  });
});
