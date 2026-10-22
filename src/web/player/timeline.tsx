import type { ChapterRevisionDto } from "../../shared/dto/chapter.ts";
import type { HighlightItemDto } from "../../shared/dto/highlight.ts";
import { formatDuration } from "../format.ts";
import { usePlayerCapabilities, usePlayerController, usePlayerTime } from "./player-controller.tsx";

/** Colour class of an AI highlight by its 0–100 score: the stronger the highlight, the warmer. */
export function highlightTone(score: number): string {
  if (score >= 90) return "bg-danger";
  if (score >= 80) return "bg-accent";
  return "bg-muted";
}

function percentOf(ms: number, duration: number): string {
  return `${Math.min(100, Math.max(0, (ms / duration) * 100))}%`;
}

/** The AI highlights as coloured marks over the whole duration; clicking one seeks to it. */
export function HighlightBand(props: { durationMs: number; highlights: readonly HighlightItemDto[]; testId?: string }) {
  const controller = usePlayerController();
  const percent = (ms: number): string => percentOf(ms, props.durationMs);
  return (
    <div className="relative h-1.5 w-full rounded bg-sunken" data-testid={props.testId ?? "highlight-band"}>
      {props.highlights.map((item) => (
        <button
          key={item.segmentId}
          type="button"
          data-highlight={item.segmentId}
          className={`absolute top-0 h-full min-w-1 rounded-sm ${highlightTone(item.score)} hover:brightness-110`}
          style={{ left: percent(item.startMs), width: `calc(${percent(item.endMs)} - ${percent(item.startMs)})` }}
          title={`${formatDuration(item.startMs)} ${item.score} ${item.text}`}
          aria-label={`${formatDuration(item.startMs)} ${item.text}`}
          onClick={() => controller.seek(item.startMs)}
        />
      ))}
    </div>
  );
}

/** The span the strip covers: the media duration, else where the last chapter or highlight ends. */
function stripDuration(durationMs: number | undefined, chapters: ChapterRevisionDto["chapters"], highlights: readonly HighlightItemDto[] | undefined): number | undefined {
  const duration = durationMs ?? chapters.at(-1)?.endMs ?? highlights?.at(-1)?.endMs;
  return duration === undefined || duration <= 0 ? undefined : duration;
}

/**
 * What stays under the local player: its chapters live in its seek bar, so
 * only the AI highlight band is left. Nothing without highlights.
 */
export function HighlightsBelowPlayer(props: { durationMs: number | undefined; chapters: ChapterRevisionDto["chapters"]; highlights: readonly HighlightItemDto[] }) {
  const duration = stripDuration(props.durationMs, props.chapters, props.highlights);
  if (duration === undefined || props.highlights.length === 0) {
    return null;
  }
  return (
    <div className="mt-2">
      <HighlightBand durationMs={duration} highlights={props.highlights} testId="timeline-highlights" />
    </div>
  );
}

/**
 * The strip under a platform player: chapter segments with their names on
 * hover, the AI highlights at or above the current threshold as a coloured band and, only
 * when the player reports time, a cursor. Clicking a chapter or highlight seeks to it.
 */
export function Timeline(props: { durationMs: number | undefined; chapters: ChapterRevisionDto["chapters"]; highlights?: readonly HighlightItemDto[] }) {
  const controller = usePlayerController();
  const capabilities = usePlayerCapabilities();
  const time = usePlayerTime();
  const duration = stripDuration(props.durationMs, props.chapters, props.highlights);
  if (duration === undefined) {
    return null;
  }
  const percent = (ms: number): string => percentOf(ms, duration);
  const highlights = props.highlights ?? [];
  return (
    <div className="mt-2 flex flex-col gap-1">
      <div className="relative h-3 w-full rounded bg-sunken" data-testid="timeline">
        {props.chapters.map((chapter, index) => (
          <button
            key={`${chapter.startMs}-${index}`}
            type="button"
            className="absolute top-0 h-full border-r border-surface bg-accent/30 hover:bg-accent/60"
            style={{ left: percent(chapter.startMs), width: `calc(${percent(chapter.endMs)} - ${percent(chapter.startMs)})` }}
            title={`${formatDuration(chapter.startMs)} ${chapter.title}`}
            aria-label={chapter.title}
            onClick={() => controller.seek(chapter.startMs)}
          />
        ))}
        {capabilities.timeTracking === "supported" && time !== undefined ? (
          <div className="pointer-events-none absolute -top-0.5 h-4 w-0.5 bg-accent" style={{ left: percent(time) }} data-testid="timeline-cursor" />
        ) : null}
      </div>
      {highlights.length === 0 ? null : <HighlightBand durationMs={duration} highlights={highlights} testId="timeline-highlights" />}
    </div>
  );
}
