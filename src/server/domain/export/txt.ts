import type { Paragraph } from "./paragraphs.ts";

/** One TXT paragraph: plain text without time stamps; paragraphs are separated by a blank line. */
export function txtParagraph(paragraph: Paragraph, first: boolean): string {
  return `${first ? "" : "\n"}${paragraph.text}\n`;
}
