import { NOTE_COLORS, type NoteColor, type NoteMark } from "../../shared/enums.ts";

/** The colour a new note of each mark starts with until the user picks another. */
const INITIAL_COLOR: Record<NoteMark, NoteColor> = { underline: "blue", background: "yellow" };

const colorKey = (mark: NoteMark): string => `amber.notes.color.${mark}`;

/** The colour last used for `mark`, a UI preference kept in this browser only. */
export function rememberedColor(mark: NoteMark): NoteColor {
  try {
    const stored = localStorage.getItem(colorKey(mark));
    return NOTE_COLORS.find((color) => color === stored) ?? INITIAL_COLOR[mark];
  } catch {
    // Private mode without storage: the initial colours still apply.
    return INITIAL_COLOR[mark];
  }
}

export function rememberColor(mark: NoteMark, color: NoteColor): void {
  try {
    localStorage.setItem(colorKey(mark), color);
  } catch {
    // Not remembered; the next note starts from the initial colour.
  }
}

// Literal class names, so the stylesheet build sees every one of them.
const BACKGROUND: Record<NoteColor, string> = {
  yellow: "bg-yellow-300/60 dark:bg-yellow-400/35",
  green: "bg-green-300/60 dark:bg-green-400/35",
  blue: "bg-sky-300/60 dark:bg-sky-400/35",
  pink: "bg-pink-300/60 dark:bg-pink-400/35",
  purple: "bg-violet-300/60 dark:bg-violet-400/35",
};

const UNDERLINE: Record<NoteColor, string> = {
  yellow: "decoration-yellow-500",
  green: "decoration-green-500",
  blue: "decoration-sky-500",
  pink: "decoration-pink-500",
  purple: "decoration-violet-500",
};

const SWATCH: Record<NoteColor, string> = {
  yellow: "bg-yellow-400",
  green: "bg-green-500",
  blue: "bg-sky-500",
  pink: "bg-pink-500",
  purple: "bg-violet-500",
};

/** Background of a run whose newest background note has `color`. */
export function backgroundClass(color: NoteColor): string {
  return BACKGROUND[color];
}

/**
 * Underline of a run whose newest underline note has `color`; set lower than the current
 * sentence's accent underline so both stay visible.
 */
export function underlineClass(color: NoteColor): string {
  return `underline decoration-2 underline-offset-[5px] ${UNDERLINE[color]}`;
}

/** A palette swatch of `color`. */
export function swatchClass(color: NoteColor): string {
  return SWATCH[color];
}
