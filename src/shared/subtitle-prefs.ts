import { z } from "zod";
import { BURN_MODES } from "./enums.ts";

/**
 * The subtitle preferences the web client keeps in local storage, shared so a
 * backup can carry and check them with the same schemas the player reads them by.
 */

/** What the local player overlays: nothing, or one of the export modes. */
export const SUBTITLE_DISPLAY_MODES = ["off", ...BURN_MODES] as const;
export type SubtitleDisplayMode = (typeof SUBTITLE_DISPLAY_MODES)[number];

export const trackPrefSchema = z
  .object({
    version: z.literal(1),
    mode: z.enum(SUBTITLE_DISPLAY_MODES),
    revisionId: z.string().min(1).exactOptional(),
    translationRevisionId: z.string().min(1).exactOptional(),
  })
  .strict();
/** The display mode and revisions picked for one Content; revisions absent mean "the defaults". */
export type SubtitleTrackPref = z.output<typeof trackPrefSchema>;

/**
 * Local UI preference keys. Every key carries the user id so two accounts in
 * one browser never inherit each other's subtitles.
 */
export const subtitlePrefKeys = {
  appearance: (userId: string) => `amber.subtitle.appearance.${userId}`,
  defaultPlacement: (userId: string) => `amber.subtitle.placement.${userId}`,
  placement: (userId: string, contentId: string) => `amber.subtitle.placement.${userId}.${contentId}`,
  track: (userId: string, contentId: string) => `amber.subtitle.track.${userId}.${contentId}`,
};
