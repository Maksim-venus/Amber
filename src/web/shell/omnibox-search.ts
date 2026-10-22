import type { CollectionDto } from "../../shared/dto/collection.ts";
import type { ContentDto } from "../../shared/dto/content.ts";

/** Prefix that switches the Omnibox from searching to the command registry. */
export const COMMAND_PREFIX = ">";

export interface OmniboxQuery {
  mode: "search" | "command";
  text: string;
}

export function parseOmniboxQuery(input: string): OmniboxQuery {
  const trimmed = input.trimStart();
  return trimmed.startsWith(COMMAND_PREFIX)
    ? { mode: "command", text: trimmed.slice(COMMAND_PREFIX.length).trim() }
    : { mode: "search", text: input.trim() };
}

/**
 * What the Omnibox lists before anything is typed: the most recent Contents and the
 * collections, as loaded. Typed queries go to the search service instead.
 */
export function recentItems(
  contents: readonly ContentDto[],
  collections: readonly CollectionDto[],
  limit: number,
): { contents: ContentDto[]; collections: CollectionDto[] } {
  return { contents: contents.slice(0, limit), collections: collections.slice(0, limit) };
}
