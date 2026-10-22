import { expect, test, type Locator, type Page } from "@playwright/test";
import { isMarked, readingSeparator } from "../../src/shared/reading.ts";
import {
  BILI_REVISION,
  installMockBackend,
  NOTES_ASR_REVISION,
  NOTES_CONTENT,
  NOTES_EDITED_INDEX,
  NOTES_LONG_FROM,
  NOTES_REVISION,
  NOTES_TITLE,
  NOTES_UNSOURCED_INDEX,
  noteSegmentId,
  noteSentence,
  notesSegments,
  segmentId,
  type MockBackend,
} from "./mock-backend.ts";

/*
 * Notes on the reading view driven with a real mouse: selections are
 * made by pressing, moving and releasing at the pixel of a character, so the offsets the
 * page computes go through the browser's own hit-testing and selection.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const sid = (index: number, revision = NOTES_REVISION): string => noteSegmentId(revision, index);
const text = (index: number, revision = NOTES_REVISION): string => noteSentence(revision, index);
/** Whether the read revision carries paragraph marks, which decides how quotes join sentences. */
const MARKED = notesSegments(NOTES_REVISION).some(isMarked);

function transcriptUrl(extra: Record<string, string> = {}): string {
  return `/contents/${NOTES_CONTENT}?${new URLSearchParams({ tab: "transcript", ...extra }).toString()}`;
}

function reader(page: Page): Locator {
  return page.getByTestId("transcript-reader");
}

function sentence(page: Page, segment: string): Locator {
  return reader(page).locator(`[data-segment-id="${segment}"]`);
}

/**
 * The viewport point of a character boundary inside a sentence: `before` the character at
 * `offset`, or `after` the one ending at it. Offsets count the text nodes of the sentence in
 * order, the same way the page computes note anchors.
 */
async function boundaryPoint(page: Page, segment: string, offset: number, side: "before" | "after"): Promise<{ x: number; y: number }> {
  const point = await page.evaluate(
    ([id, at, edge]) => {
      const element = document.querySelector(`[data-testid="transcript-reader"] [data-segment-id="${id}"]`);
      if (element === null) return null;
      const target = edge === "before" ? Number(at) : Number(at) - 1;
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let seen = 0;
      for (let node = walker.nextNode() as Text | null; node !== null; node = walker.nextNode() as Text | null) {
        if (target < seen + node.data.length) {
          const range = document.createRange();
          range.setStart(node, target - seen);
          range.setEnd(node, target - seen + 1);
          const box = range.getClientRects()[0];
          if (box === undefined) return null;
          return { x: edge === "before" ? box.left + 1 : box.right - 1, y: (box.top + box.bottom) / 2 };
        }
        seen += node.data.length;
      }
      return null;
    },
    [segment, String(offset), side] as const,
  );
  if (point === null) throw new Error(`no character ${offset} (${side}) in ${segment}`);
  return point;
}

/** Presses at one character boundary, moves to another in steps and releases. */
async function dragSelect(page: Page, from: { segment: string; offset: number }, to: { segment: string; offset: number }): Promise<void> {
  const start = await boundaryPoint(page, from.segment, from.offset, "before");
  const end = await boundaryPoint(page, to.segment, to.offset, "after");
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 8 });
  await page.mouse.up();
}

async function clearSelection(page: Page): Promise<void> {
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
}

function posts(backend: MockBackend) {
  return backend.notes.requests.filter((request) => request.method === "POST");
}

async function openReader(page: Page, extra: Record<string, string> = {}): Promise<void> {
  await page.goto(transcriptUrl(extra));
  await expect(page.getByTestId("output-tab-transcript")).toHaveAttribute("aria-selected", "true");
  await expect(sentence(page, sid(0))).toBeVisible();
}

test("a mouse drag inside one sentence offers five actions; 高亮 stores the exact offsets under an Idempotency-Key", async ({ page }) => {
  const backend = await installMockBackend(page);
  await openReader(page);
  await expect(page.locator("[data-notes]")).toHaveCount(1);

  const target = sid(6);
  const start = text(6).indexOf("学");
  const end = text(6).indexOf("点") + 1;
  await dragSelect(page, { segment: target, offset: start }, { segment: target, offset: end });

  const toolbar = page.getByTestId("selection-toolbar");
  await expect(toolbar).toBeVisible();
  await expect(toolbar.getByRole("button")).toHaveCount(5);
  for (const id of ["selection-explain", "selection-copy", "selection-note-underline", "selection-note-background", "selection-note-comment"]) {
    await expect(toolbar.getByTestId(id)).toBeVisible();
  }

  await toolbar.getByTestId("selection-note-background").click();
  await expect.poll(() => backend.notes.list().length).toBe(1);
  const [post] = posts(backend);
  expect(post?.body).toEqual({
    transcriptRevisionId: NOTES_REVISION,
    startSegmentId: target,
    startOffset: start,
    endSegmentId: target,
    endOffset: end,
    mark: "background",
    color: "yellow",
  });
  expect(post?.idempotencyKey).toMatch(UUID);
  const note = backend.notes.list()[0];
  expect(note?.quote).toBe(text(6).slice(start, end));

  const run = sentence(page, target).locator(`[data-testid="note-run"][data-note-ids~="${note?.id}"]`);
  await expect(run).toHaveText(text(6).slice(start, end));
  await expect(run).toHaveAttribute("role", "button");
  await expect(toolbar).toHaveCount(0);
});

test("holding the mouse across several screens of a windowed revision keeps the start row and anchors the right sentences", async ({ page }) => {
  const backend = await installMockBackend(page);
  const first = NOTES_LONG_FROM + 10;
  const last = first + 15;
  // Opening on the start sentence scrolls the windowed list to it.
  await page.goto(transcriptUrl({ segment: sid(first) }));
  await expect(sentence(page, sid(first))).toBeVisible();
  // Windowed: the rows near the top are not mounted.
  await expect(sentence(page, sid(0))).toHaveCount(0);

  const start = await boundaryPoint(page, sid(first), 2, "before");
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  // A user starts dragging before scrolling; the selection gesture begins with this move.
  await page.mouse.move(start.x + 20, start.y, { steps: 3 });
  const box = await reader(page).boundingBox();
  if (box === null) throw new Error("reader not laid out");
  // Wheel while the button is held until the end sentence sits in the upper half of the list.
  for (let turn = 0; turn < 40; turn += 1) {
    const top = await sentence(page, sid(last))
      .evaluate((element) => element.getBoundingClientRect().top, undefined, { timeout: 200 })
      .catch(() => Number.POSITIVE_INFINITY);
    if (top > box.y && top < box.y + box.height / 2) break;
    await page.mouse.wheel(0, 250);
    await page.waitForTimeout(50);
  }
  const startTop = await sentence(page, sid(first)).evaluate((element) => element.getBoundingClientRect().bottom, undefined, { timeout: 2_000 });
  // The start sentence has scrolled far out of view, yet it stays mounted and keeps the selection's anchor.
  expect(startTop).toBeLessThan(box.y);
  await expect(sentence(page, sid(first))).toHaveCount(1);
  // Its neighbour, equally far out, has been windowed away: only the start row is pinned.
  await expect(sentence(page, sid(first + 1))).toHaveCount(0);
  const anchoredIn = await page.evaluate(() => {
    const node = window.getSelection()?.anchorNode;
    return node?.isConnected === true ? (node instanceof Element ? node : node.parentElement)?.closest("[data-segment-id]")?.getAttribute("data-segment-id") : null;
  });
  expect(anchoredIn).toBe(sid(first));

  const end = await boundaryPoint(page, sid(last), 4, "after");
  await page.mouse.move(end.x, end.y, { steps: 6 });
  await page.mouse.up();

  const toolbar = page.getByTestId("selection-toolbar");
  await expect(toolbar.getByTestId("selection-note-underline")).toBeEnabled();
  await toolbar.getByTestId("selection-note-underline").click();
  await expect.poll(() => backend.notes.list().length).toBe(1);
  expect(posts(backend)[0]?.body).toEqual({
    transcriptRevisionId: NOTES_REVISION,
    startSegmentId: sid(first),
    startOffset: 2,
    endSegmentId: sid(last),
    endOffset: 4,
    mark: "underline",
    color: "blue",
  });
  const note = backend.notes.list()[0];
  const expected = Array.from({ length: last - first + 1 }, (_, index) => first + index).reduce((quote, index) => {
    const piece = index === first ? text(index).slice(2) : index === last ? text(index).slice(0, 4) : text(index);
    return index === first ? piece : `${quote}${readingSeparator(text(index - 1), text(index), MARKED)}${piece}`;
  }, "");
  expect(note?.quote).toBe(expected);
  await expect(sentence(page, sid(last)).locator(`[data-testid="note-run"][data-note-ids~="${note?.id}"]`)).toHaveText(text(last).slice(0, 4));
});

test("search marks split the sentence into several text nodes; the anchor offsets still count the whole sentence", async ({ page }) => {
  const backend = await installMockBackend(page);
  await openReader(page, { search: "笔记" });
  const target = sid(6);
  await expect(sentence(page, target).locator("mark")).toHaveText("笔记");

  const start = text(6).indexOf("习");
  const end = text(6).indexOf("要") + 1;
  await dragSelect(page, { segment: target, offset: start }, { segment: target, offset: end });
  await page.getByTestId("selection-note-background").click();
  await expect.poll(() => backend.notes.list().length).toBe(1);
  expect(posts(backend)[0]?.body).toMatchObject({ startSegmentId: target, startOffset: start, endSegmentId: target, endOffset: end });
  expect(backend.notes.list()[0]?.quote).toBe("习笔记要");
  const runs = sentence(page, target).getByTestId("note-run");
  await expect(runs.first()).toBeVisible();
  expect((await runs.allTextContents()).join("")).toBe("习笔记要");
  // The search mark is still shown inside the noted text.
  await expect(sentence(page, target).locator("mark")).toHaveText("笔记");
});

test("a selection across a chapter heading anchors on the sentences either side of it", async ({ page }) => {
  const backend = await installMockBackend(page);
  await openReader(page);
  await expect(reader(page).getByTestId("transcript-chapter").nth(1)).toContainText("第 2 章");

  const start = text(3).indexOf("要");
  const end = text(4).indexOf("习") + 1;
  await dragSelect(page, { segment: sid(3), offset: start }, { segment: sid(4), offset: end });
  await page.getByTestId("selection-note-underline").click();
  await expect.poll(() => backend.notes.list().length).toBe(1);
  expect(posts(backend)[0]?.body).toMatchObject({ startSegmentId: sid(3), startOffset: start, endSegmentId: sid(4), endOffset: end });
  const note = backend.notes.list()[0];
  expect(note?.quote).toBe(`${text(3).slice(start)}${readingSeparator(text(3), text(4), MARKED)}${text(4).slice(0, end)}`);
  await expect(sentence(page, sid(3)).locator(`[data-note-ids~="${note?.id}"]`)).toHaveText(text(3).slice(start));
  await expect(sentence(page, sid(4)).locator(`[data-note-ids~="${note?.id}"]`)).toHaveText(text(4).slice(0, end));
});

test("dragging across or inside a mark selects without seeking; a plain click on the mark opens its popover", async ({ page }) => {
  const backend = await installMockBackend(page);
  const note = backend.notes.seed({ transcriptRevisionId: NOTES_REVISION, startSegmentId: sid(1), startOffset: 6, endSegmentId: sid(1), endOffset: 10 });
  await openReader(page);
  const run = sentence(page, sid(1)).locator(`[data-testid="note-run"][data-note-ids~="${note.id}"]`);
  await expect(run).toHaveText(text(1).slice(6, 10));
  const frame = page.getByTestId("player-bilibili");
  await expect(frame).toHaveAttribute("src", /bvid=/u);
  const src = await frame.getAttribute("src");
  const unseeked = async (): Promise<void> => {
    // Give a stray click handler time to write the URL or reload the player.
    await page.waitForTimeout(300);
    expect(new URL(page.url()).searchParams.get("segment")).toBeNull();
    expect(await frame.getAttribute("src")).toBe(src);
    await expect(page.getByTestId("note-popover")).toHaveCount(0);
  };

  // Across the mark, from before it to after it.
  await dragSelect(page, { segment: sid(1), offset: 4 }, { segment: sid(1), offset: 13 });
  await expect(page.getByTestId("selection-toolbar")).toBeVisible();
  await unseeked();
  await clearSelection(page);

  // Pressed and released on the mark itself.
  await dragSelect(page, { segment: sid(1), offset: 7 }, { segment: sid(1), offset: 9 });
  await expect(page.getByTestId("selection-toolbar")).toBeVisible();
  await unseeked();
  await clearSelection(page);

  await run.click();
  const popover = page.getByTestId("note-popover");
  await expect(popover).toBeVisible();
  await expect(popover.getByTestId("note-card")).toHaveCount(1);
  expect(new URL(page.url()).searchParams.get("segment")).toBeNull();
  expect(await frame.getAttribute("src")).toBe(src);
});

test("keyboard: Tab reaches a mark, Enter opens its popover, Escape closes it and focus returns to the mark", async ({ page }) => {
  const backend = await installMockBackend(page);
  const note = backend.notes.seed({ transcriptRevisionId: NOTES_REVISION, startSegmentId: sid(1), startOffset: 6, endSegmentId: sid(1), endOffset: 10, mark: "underline", color: "green" });
  await openReader(page);
  const run = sentence(page, sid(1)).locator(`[data-testid="note-run"][data-note-ids~="${note.id}"]`);
  await expect(run).toBeVisible();

  // The paragraph's time button comes right before the mark in tab order.
  await reader(page).locator("p", { has: page.locator(`[data-segment-id="${sid(1)}"]`) }).locator("[data-reading-time]").focus();
  await page.keyboard.press("Tab");
  await expect(run).toBeFocused();
  await page.keyboard.press("Enter");
  const popover = page.getByTestId("note-popover");
  await expect(popover).toBeVisible();
  await expect(popover.getByTestId("note-card")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);
  await expect(run).toBeFocused();
  expect(new URL(page.url()).searchParams.get("segment")).toBeNull();
});

test("a comment draft survives a failed save; the retry stores exactly one note", async ({ page }) => {
  const backend = await installMockBackend(page);
  await openReader(page);
  const target = sid(8);
  await dragSelect(page, { segment: target, offset: 6 }, { segment: target, offset: 10 });
  await page.getByTestId("selection-note-comment").click();

  const compose = page.getByTestId("note-compose");
  await expect(compose).toBeVisible();
  // The draft opens beside the selected words, not pinned to the page corner.
  const sentenceBox = await page.locator(`[data-notes] [data-segment-id="${target}"]`).first().boundingBox();
  const popoverBox = await page.getByTestId("note-popover").boundingBox();
  expect(sentenceBox).not.toBeNull();
  expect(popoverBox).not.toBeNull();
  if (sentenceBox !== null && popoverBox !== null) {
    // Below the selection, or flipped above it when the viewport has no room below.
    const gap = Math.max(sentenceBox.y - (popoverBox.y + popoverBox.height), popoverBox.y - (sentenceBox.y + sentenceBox.height));
    expect(gap).toBeLessThan(40);
  }
  const input = compose.getByTestId("note-compose-input");
  await expect(input).toBeFocused();
  await input.fill("这句要复习");
  expect(backend.notes.list()).toHaveLength(0);

  backend.notes.injectCreateFault("fail_before_write");
  await compose.getByTestId("note-compose-save").click();
  await expect.poll(() => posts(backend).map((request) => request.outcome)).toEqual(["failed"]);
  await expect(compose).toBeVisible();
  await expect(input).toHaveValue("这句要复习");
  expect(backend.notes.list()).toHaveLength(0);

  await compose.getByTestId("note-comment-retry").or(compose.getByTestId("note-compose-save")).first().click();
  await expect(compose).toHaveCount(0);
  expect(backend.notes.list()).toHaveLength(1);
  const note = backend.notes.list()[0];
  expect(note?.comment).toBe("这句要复习");
  expect(note?.quote).toBe(text(8).slice(6, 10));
  const [failed, retried] = posts(backend);
  expect(retried?.outcome).toBe("created");
  expect(retried?.idempotencyKey).toBe(failed?.idempotencyKey);
  expect(retried?.body).toEqual(failed?.body);
  await expect(sentence(page, target).locator(`[data-testid="note-run"][data-note-ids~="${note?.id}"]`)).toBeVisible();
});

test("高亮 whose response is lost after the write is retried with the same key and stores one note", async ({ page }) => {
  const backend = await installMockBackend(page);
  await openReader(page);
  const target = sid(10);
  await dragSelect(page, { segment: target, offset: 6 }, { segment: target, offset: 10 });
  backend.notes.injectCreateFault("drop_response");
  await page.getByTestId("selection-note-background").click();

  const retry = page.getByTestId("selection-note-retry");
  await expect(retry).toBeVisible();
  expect(posts(backend).map((request) => request.outcome)).toEqual(["dropped"]);
  expect(backend.notes.list()).toHaveLength(1);
  await retry.click();

  await expect.poll(() => posts(backend).map((request) => request.outcome)).toEqual(["dropped", "replayed"]);
  const [lost, replayed] = posts(backend);
  expect(replayed?.idempotencyKey).toBe(lost?.idempotencyKey);
  expect(replayed?.body).toEqual(lost?.body);
  expect(backend.notes.list()).toHaveLength(1);
  const note = backend.notes.list()[0];
  await expect(sentence(page, target).locator(`[data-testid="note-run"][data-note-ids~="${note?.id}"]`)).toHaveText(text(10).slice(6, 10));
  await expect(page.getByTestId("selection-toolbar")).toHaveCount(0);
});

test("on another version a note shows exactly where the text is unchanged, as whole sentences otherwise, and is counted when it cannot be placed", async ({ page }) => {
  const backend = await installMockBackend(page);
  const same = backend.notes.seed({ transcriptRevisionId: NOTES_REVISION, startSegmentId: sid(1), startOffset: 6, endSegmentId: sid(1), endOffset: 10 });
  const edited = backend.notes.seed({ transcriptRevisionId: NOTES_REVISION, startSegmentId: sid(NOTES_EDITED_INDEX), startOffset: 6, endSegmentId: sid(NOTES_EDITED_INDEX), endOffset: 10 });
  const lost = backend.notes.seed({ transcriptRevisionId: NOTES_REVISION, startSegmentId: sid(NOTES_UNSOURCED_INDEX), startOffset: 6, endSegmentId: sid(NOTES_UNSOURCED_INDEX), endOffset: 10 });
  await openReader(page);
  await expect(reader(page).getByTestId("note-run")).toHaveCount(3);
  await expect(page.getByTestId("transcript-notes-unmapped")).toHaveCount(0);

  await page.getByTestId("transcript-version").selectOption(NOTES_ASR_REVISION);
  await expect(page).toHaveURL(new RegExp(`revision=${NOTES_ASR_REVISION}`, "u"));
  const asrSentence = (index: number) => sentence(page, sid(index, NOTES_ASR_REVISION));
  await expect(asrSentence(1)).toBeVisible();
  expect(backend.notes.requests.some((request) => request.method === "GET" && request.path.includes(`revision=${NOTES_ASR_REVISION}`))).toBe(true);

  await expect(asrSentence(1).locator(`[data-note-ids~="${same.id}"]`)).toHaveText(text(1, NOTES_ASR_REVISION).slice(6, 10));
  await expect(asrSentence(NOTES_EDITED_INDEX).locator(`[data-note-ids~="${edited.id}"]`)).toHaveText(text(NOTES_EDITED_INDEX, NOTES_ASR_REVISION));
  await expect(reader(page).locator(`[data-note-ids~="${lost.id}"]`)).toHaveCount(0);
  await expect(page.getByTestId("transcript-notes-unmapped")).toContainText("1");

  await asrSentence(NOTES_EDITED_INDEX).locator(`[data-note-ids~="${edited.id}"]`).click();
  const popover = page.getByTestId("note-popover");
  await expect(popover).toBeVisible();
  await expect(popover).toContainText("基于另一版本");
});

test("/notes groups Contents latest first, and 定位原文 opens the anchor revision on the start sentence", async ({ page }) => {
  const backend = await installMockBackend(page);
  backend.notes.seed({ transcriptRevisionId: BILI_REVISION, startSegmentId: segmentId(BILI_REVISION, 3), startOffset: 0, endSegmentId: segmentId(BILI_REVISION, 3), endOffset: 3 });
  const firstNote = backend.notes.seed({ transcriptRevisionId: NOTES_REVISION, startSegmentId: sid(6), startOffset: 6, endSegmentId: sid(7), endOffset: 4, comment: "跨两句的评论" });
  backend.notes.seed({ transcriptRevisionId: NOTES_REVISION, startSegmentId: sid(12), startOffset: 6, endSegmentId: sid(12), endOffset: 10, mark: "underline", color: "purple" });

  await page.goto("/library");
  await page.getByRole("link", { name: "笔记", exact: true }).click();
  await expect(page).toHaveURL(/\/notes$/u);
  const notesPage = page.getByTestId("notes-page");
  await expect(notesPage).toContainText("2 个内容有笔记");
  const groups = notesPage.getByTestId("notes-group");
  await expect(groups).toHaveCount(2);
  await expect(groups.nth(0)).toContainText(NOTES_TITLE);
  await expect(groups.nth(1)).toContainText("第二讲：B 站模拟课程");
  // The first group opens by itself; the others wait for a click.
  await expect(groups.nth(0).getByTestId("note-card")).toHaveCount(2);
  await expect(groups.nth(1).getByTestId("note-card")).toHaveCount(0);
  await groups.nth(1).getByTestId("notes-group-toggle").click();
  await expect(groups.nth(1).getByTestId("note-card")).toHaveCount(1);
  await expect(groups.nth(0)).toContainText("跨两句的评论");

  await groups.nth(0).getByTestId("note-locate").first().click();
  await expect(page).toHaveURL(new RegExp(`/contents/${NOTES_CONTENT}\\?`, "u"));
  const url = new URL(page.url());
  expect(url.searchParams.get("tab")).toBe("transcript");
  expect(url.searchParams.get("revision")).toBe(NOTES_REVISION);
  expect(url.searchParams.get("segment")).toBe(firstNote.startSegmentId);
  await expect(sentence(page, sid(6))).toHaveAttribute("aria-current", "true");
  await expect(sentence(page, sid(6)).locator(`[data-note-ids~="${firstNote.id}"]`)).toBeVisible();

  // The reading view links back to this Content's notes.
  await page.getByTestId("transcript-notes-link").click();
  await expect(page).toHaveURL(new RegExp(`/notes\\?contentId=${NOTES_CONTENT}`, "u"));
  await expect(page.getByTestId("notes-group")).toHaveCount(1);
  await expect(page.getByTestId("notes-group").getByTestId("note-card")).toHaveCount(2);
  expect(backend.mutations.filter((mutation) => mutation.path.includes("/notes"))).toEqual([]);
});
