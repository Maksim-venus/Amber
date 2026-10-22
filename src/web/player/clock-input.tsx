import { useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { formatDuration } from "../format.ts";

const CLOCK_PART = /^\d+$/;
/** `:` or U+FF1A, the full-width colon a Chinese IME types by default. */
const CLOCK_SEPARATOR = /[:\uFF1A]/;

/**
 * Parses a typed clock — `h:mm:ss`, `m:ss` or plain seconds — into milliseconds. A
 * full-width colon counts as `:` so a Chinese IME needs no switching. Every part is a
 * non-negative integer; after the first, each part must be below 60. Anything else,
 * the empty string included, is `undefined`.
 */
export function parseClock(text: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  const parts = trimmed.split(CLOCK_SEPARATOR);
  if (parts.length > 3 || !parts.every((part) => CLOCK_PART.test(part))) return undefined;
  const values = parts.map(Number);
  if (values.slice(1).some((value) => value >= 60)) return undefined;
  const seconds = values.reduce((total, value) => total * 60 + value, 0);
  return Number.isSafeInteger(seconds * 1000) ? seconds * 1000 : undefined;
}

/**
 * The player's current time as an editable field: it reads like plain text until hovered
 * or focused, and Enter jumps to the typed time (clamped to the media) while Escape or
 * leaving the field drops the edit. Once focused, the draft is the user's — playback keeps
 * running but its time updates no longer overwrite what is being typed. Enter that only
 * confirms an IME composition is not a submit. `onDone` runs after Enter / Escape so the
 * caller can hand focus back to the player, where its keyboard shortcuts live.
 */
export function ClockInput(props: { positionMs: number; durationMs: number | undefined; onSeek: (ms: number) => void; onDone: () => void }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<string | undefined>(undefined);
  // A mouse click focuses, then its mouseup would collapse the select-all; skip that one.
  const keepSelection = useRef(false);
  const current = formatDuration(props.positionMs);
  // At rest the field hugs the time so it reads as `0:00 / 1:06:40`, changing width only when
  // the time gains a digit; while editing it has room for the longest time this media can show.
  const width =
    draft === undefined ? current.length : Math.max(4, draft.length, current.length, formatDuration(props.durationMs ?? props.positionMs).length);

  const finish = (): void => {
    setDraft(undefined);
    props.onDone();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Enter") {
      if (event.nativeEvent.isComposing) return;
      event.preventDefault();
      const ms = parseClock(draft ?? current);
      if (ms !== undefined) props.onSeek(Math.max(0, props.durationMs === undefined ? ms : Math.min(ms, props.durationMs)));
      finish();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      finish();
    }
  };

  const label = t("contentView.player.seekToTime");
  return (
    <input
      type="text"
      inputMode="numeric"
      spellCheck={false}
      autoComplete="off"
      value={draft ?? current}
      aria-label={label}
      title={label}
      style={{ width: `${width}ch` }}
      className="box-content rounded-sm border-0 bg-transparent px-0.5 font-mono text-xs text-white tabular-nums outline-none hover:bg-white/15 hover:ring-1 hover:ring-white/40 focus:bg-black/60 focus:ring-1 focus:ring-white/70"
      onFocus={(event) => {
        setDraft(current);
        event.currentTarget.select();
      }}
      onMouseDown={(event) => {
        keepSelection.current = event.currentTarget.ownerDocument.activeElement !== event.currentTarget;
      }}
      onMouseUp={(event) => {
        if (keepSelection.current) event.preventDefault();
        keepSelection.current = false;
      }}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={onKeyDown}
      onBlur={() => setDraft(undefined)}
      data-testid="player-clock-input"
    />
  );
}
