/** A progress sink taking values in [0, 1]. */
export type ProgressSink = (progress: number) => void;

/** Passes progress on only when it moves forward. */
export function monotonic(report: ProgressSink): ProgressSink {
  let reported = 0;
  return (progress) => {
    if (progress > reported) {
      reported = Math.min(1, progress);
      report(reported);
    }
  };
}

/**
 * Maps a step's own progress in [0, 1] onto its segment `[from, to]` of the stage's
 * progress, so consecutive steps of one stage fill the bar one after another.
 */
export function span(report: ProgressSink, from: number, to: number): ProgressSink {
  return (progress) => report(from + Math.min(1, Math.max(0, progress)) * (to - from));
}
