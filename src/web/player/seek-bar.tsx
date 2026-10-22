import { useState, type CSSProperties, type PointerEvent } from "react";
import { useTranslation } from "react-i18next";
import type { ChapterRevisionDto } from "../../shared/dto/chapter.ts";
import { formatDuration } from "../format.ts";

export type ChapterEntry = ChapterRevisionDto["chapters"][number];

const PLAYED = "var(--color-accent)";
const REST = "var(--seek-rest)";
/** Half the transparent gap drawn at each chapter boundary. */
const GAP_HALF = "1px";

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

/**
 * The seek track as a CSS gradient: the played part in the accent colour, the rest
 * translucent, and a small transparent gap where one chapter ends and the next begins
 * Without chapters the track is one continuous bar.
 */
export function seekTrackGradient(durationMs: number, positionMs: number, chapters: readonly ChapterEntry[]): string {
  if (durationMs <= 0) return `linear-gradient(90deg, ${REST} 0%, ${REST} 100%)`;
  const played = clampPercent((positionMs / durationMs) * 100);
  const boundaries = [...new Set(chapters.map((chapter) => chapter.startMs).filter((start) => start > 0 && start < durationMs))]
    .sort((a, b) => a - b)
    .map((start) => (start / durationMs) * 100);
  const edges = [0, ...boundaries, 100];
  const stops: string[] = [];
  for (let index = 0; index < edges.length - 1; index += 1) {
    const from = edges[index] as number;
    const to = edges[index + 1] as number;
    const last = index === edges.length - 2;
    const start = index === 0 ? "0%" : `calc(${from}% + ${GAP_HALF})`;
    const end = last ? "100%" : `calc(${to}% - ${GAP_HALF})`;
    if (played > from && played < to) {
      stops.push(`${PLAYED} ${start}`, `${PLAYED} ${played}%`, `${REST} ${played}%`, `${REST} ${end}`);
    } else {
      const color = played >= to ? PLAYED : REST;
      stops.push(`${color} ${start}`, `${color} ${end}`);
    }
    if (!last) stops.push(`transparent ${end}`, `transparent calc(${to}% + ${GAP_HALF})`);
  }
  return `linear-gradient(90deg, ${stops.join(", ")})`;
}

/** The chapter playing at `ms`: the last one that has started by then. */
export function chapterAt(chapters: readonly ChapterEntry[], ms: number): ChapterEntry | undefined {
  let found: ChapterEntry | undefined;
  for (const chapter of chapters) {
    if (chapter.startMs <= ms && (found === undefined || chapter.startMs >= found.startMs)) found = chapter;
  }
  return found;
}

/**
 * The local player's seek bar: a native range (so keyboard and assistive technology work as
 * usual) whose track shows chapters, with a tooltip of the time and chapter under the
 * pointer. While it is dragged the parent shows the dragged position (`onScrub`) until
 * `onScrubEnd`, so a late time update cannot pull it back.
 */
export function SeekBar(props: {
  durationMs: number | undefined;
  positionMs: number;
  chapters: readonly ChapterEntry[];
  onScrub: (ms: number) => void;
  onScrubEnd: () => void;
}) {
  const { t } = useTranslation();
  const [hover, setHover] = useState<{ x: number; ms: number } | undefined>(undefined);
  const duration = props.durationMs;
  const onPointerMove = (event: PointerEvent<HTMLInputElement>): void => {
    if (duration === undefined) return;
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width <= 0) return;
    const x = Math.min(box.width, Math.max(0, event.clientX - box.left));
    setHover({ x, ms: Math.round((x / box.width) * duration) });
  };
  const chapter = hover === undefined ? undefined : chapterAt(props.chapters, hover.ms);
  const track = { "--seek-track": seekTrackGradient(duration ?? 0, props.positionMs, props.chapters) } as CSSProperties;
  return (
    <div className="relative flex h-4 items-center">
      {hover === undefined ? null : (
        <div
          className="pointer-events-none absolute bottom-full mb-1 -translate-x-1/2 rounded bg-black/80 px-1.5 py-0.5 text-xs whitespace-nowrap text-white"
          style={{ left: hover.x }}
          data-testid="player-seek-tooltip"
        >
          {chapter === undefined ? formatDuration(hover.ms) : t("contentView.player.seekTooltip", { time: formatDuration(hover.ms), chapter: chapter.title })}
        </div>
      )}
      <input
        type="range"
        min={0}
        max={duration ?? 0}
        step={1000}
        value={Math.min(props.positionMs, duration ?? 0)}
        disabled={duration === undefined}
        aria-label={t("contentView.player.seek")}
        className="seek-bar w-full"
        style={track}
        onChange={(event) => props.onScrub(Number(event.target.value))}
        onPointerUp={props.onScrubEnd}
        onKeyUp={props.onScrubEnd}
        onBlur={props.onScrubEnd}
        onPointerMove={onPointerMove}
        onPointerLeave={() => setHover(undefined)}
        data-testid="player-seek"
      />
    </div>
  );
}
