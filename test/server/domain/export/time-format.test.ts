import { describe, expect, it } from "vitest";
import { assTime, dateText, durationText, markdownTime, srtTime, vttTime } from "../../../../src/server/domain/export/time-format.ts";

describe("export time formats", () => {
  it("keep every hour digit: SRT, VTT and ASS never truncate the hour", () => {
    const sixHours = 6 * 3_600_000 + 1234;
    expect(srtTime(sixHours)).toBe("06:00:01,234");
    expect(vttTime(sixHours)).toBe("06:00:01.234");
    expect(assTime(sixHours)).toBe("6:00:01.23");
    expect(srtTime(123 * 3_600_000)).toBe("123:00:00,000");
    expect(assTime(123 * 3_600_000 + 999)).toBe("123:00:00.99");
  });

  it("write Markdown stamps as mm:ss below the 100th minute and h:mm:ss from it", () => {
    expect(markdownTime(0)).toBe("00:00");
    expect(markdownTime(5_999_000)).toBe("99:59");
    expect(markdownTime(6_000_000)).toBe("1:40:00");
    expect(markdownTime(6 * 3_600_000 + 1234)).toBe("6:00:01");
  });

  it("write the duration as h:mm:ss and the date as YYYY-MM-DD in local time", () => {
    expect(durationText(3_725_000)).toBe("1:02:05");
    expect(durationText(59_000)).toBe("0:00:59");
    const local = new Date(2026, 9, 1, 23, 30).getTime();
    expect(dateText(local)).toBe("2026-10-01");
  });
});
