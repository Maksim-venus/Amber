/**
 * WorkUnit keys the UI names as the running step of a stage. The
 * pipeline creates its units with these keys, so a renamed key also renames the step.
 */
export const FETCH_AUDIO_UNIT_KEY = "media:fetch_audio";
export const EXTRACT_AUDIO_UNIT_KEY = "media:extract_audio";
export const ASR_SUBMIT_UNIT_KEY = "asr:submit";
/** Waits for an asynchronous ASR job submitted by `asr:submit` and fetches its result. */
export const ASR_AWAIT_UNIT_KEY = "asr:await";

/** The step each named unit stands for. */
export const WORK_STEPS = {
  [FETCH_AUDIO_UNIT_KEY]: "fetchAudio",
  [EXTRACT_AUDIO_UNIT_KEY]: "extractAudio",
  [ASR_SUBMIT_UNIT_KEY]: "transcribe",
  [ASR_AWAIT_UNIT_KEY]: "awaitResult",
} as const satisfies Readonly<Record<string, string>>;

export type WorkStep = (typeof WORK_STEPS)[keyof typeof WORK_STEPS];

export const WORK_STEP_NAMES = ["fetchAudio", "extractAudio", "transcribe", "awaitResult"] as const satisfies readonly WorkStep[];

/** The step a WorkUnit key stands for, or `undefined` for a unit the UI does not name. */
export function workStepOf(key: string): WorkStep | undefined {
  return Object.hasOwn(WORK_STEPS, key) ? WORK_STEPS[key as keyof typeof WORK_STEPS] : undefined;
}
