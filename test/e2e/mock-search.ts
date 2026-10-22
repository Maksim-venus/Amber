import type { Request, Route } from "@playwright/test";
import { searchResultDtoSchema, type SearchRange } from "../../src/shared/dto/search.ts";
import { BILI_REVISION, BILIBILI_CONTENT, segmentId } from "./mock-backend.ts";

/**
 * `GET /api/search` of the fake backend over the always-processed bilibili lecture: its
 * title and its twelve sentences (the texts mirror the fake segments). Every term must
 * occur, like the real service; ranges mark each term occurrence in the returned text.
 */
const TITLE = "第二讲：B 站模拟课程";
const SEGMENT_COUNT = 12;
const SEGMENT_MS = 10_000;
const sentence = (index: number): string => `第 ${index + 1} 句模拟字幕。`;

function match(text: string, terms: readonly string[]): SearchRange[] | undefined {
  const lower = text.toLowerCase();
  const ranges: SearchRange[] = [];
  for (const term of terms) {
    const needle = term.toLowerCase();
    if (!lower.includes(needle)) {
      return undefined;
    }
    for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, at + needle.length)) {
      ranges.push({ start: at, end: at + needle.length });
    }
  }
  return ranges.sort((a, b) => a.start - b.start);
}

export async function handleSearch(route: Route, request: Request, url: URL, hidden: (contentId: string) => boolean = () => false): Promise<boolean> {
  if (request.method() !== "GET" || url.pathname !== "/api/search") {
    return false;
  }
  const terms = (url.searchParams.get("q") ?? "").split(/\s+/).filter((term) => term !== "");
  // A trashed lecture leaves the search projection: nothing of it is found.
  const gone = hidden(BILIBILI_CONTENT);
  const titleRanges = gone ? undefined : match(TITLE, terms);
  const segments = gone ? [] : Array.from({ length: SEGMENT_COUNT }, (_, index) => ({ index, ranges: match(sentence(index), terms) })).flatMap(({ index, ranges }) =>
    ranges === undefined
      ? []
      : [
          {
            contentId: BILIBILI_CONTENT,
            contentTitle: TITLE,
            transcriptRevisionId: BILI_REVISION,
            segmentId: segmentId(BILI_REVISION, index),
            startMs: index * SEGMENT_MS,
            snippet: sentence(index),
            ranges,
          },
        ],
  );
  const body = searchResultDtoSchema.parse({
    contents: titleRanges === undefined ? [] : [{ contentId: BILIBILI_CONTENT, title: TITLE, matchedIn: "title", snippet: TITLE, ranges: titleRanges }],
    segments,
    summaries: [],
    collections: [],
  });
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  return true;
}
