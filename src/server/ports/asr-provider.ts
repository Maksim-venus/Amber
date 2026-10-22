import type { AsrPreset } from "../../shared/asr-presets.ts";
import type { CanonicalAsrResult } from "../domain/asr.ts";
import type { MediaAsset } from "../domain/media-asset.ts";
import type { AsrProviderProfile } from "../domain/provider-profile.ts";
import type { TerminologyEntry } from "../domain/terminology.ts";

/**
 * Static declaration by each adapter, taken from the provider's official documentation;
 * an adapter serving several models declares it per model. ASR has no
 * declared/observed/override layering; that exists only for LLMs.
 */
export interface AsrProviderCapabilities {
  wordTimestamps: boolean;
  segmentTimestamps: boolean;
  diarization: boolean;
  terminologyBias: boolean;
  maxFileBytes: number;
  maxDurationSec: number;
  maxTerminologyEntries?: number;
  maxTerminologyTermChars?: number;
  maxTerminologyWords?: number;
  chunkingStrategy: "providerManaged" | "applicationManaged";
  /**
   * `sync`: one call returns the result. `job`: a submission returns a job handle whose
   * state is queried until the result is ready.
   */
  delivery: "sync" | "job";
}

/**
 * The audio an adapter reads: a stored file and what it is. A Task passes its extracted
 * audio asset; a model test passes a generated sound that is no MediaAsset.
 */
export type AsrAudioInput = Pick<MediaAsset, "storageRef" | "mimeType" | "sizeBytes" | "durationMs">;

export interface AsrTranscribeInput {
  audio: AsrAudioInput;
  language?: string;
  /** Effective terminology, already truncated deterministically to the declared limits. */
  terminology: TerminologyEntry[];
  speakerHint?: number;
}

export interface AsrTranscribeOptions {
  signal: AbortSignal;
  onProgress?: (progress: number) => void;
}

export interface AsrSubmitOptions extends AsrTranscribeOptions {
  /**
   * Called exactly once, right before the request that creates the paid job is sent:
   * everything before it (credentials, upload space, the upload itself) is free, so a crash
   * before it is not an unknown paid outcome. Invariant: a paid call whose outcome is
   * unknown is never resent automatically.
   */
  onPaidCallStart(): void;
}

/**
 * What identifies a submitted job to its provider; persisted with the submitting WorkUnit
 * and never deleted while the Task lives. Carries no credential or URL.
 */
export interface AsrJobHandle {
  version: 1;
  provider: string;
  jobId: string;
  submittedAt: number;
}

/**
 * One state query of a job: still `pending` (with the provider's own wait when it named
 * one), `missing` (the provider does not know the job, or no longer does), or `done` with
 * the provider-neutral result. A job that ended in failure is thrown as an error.
 */
export type AsrJobStatus =
  | { state: "pending"; retryAfterMs?: number }
  | { state: "missing" }
  | { state: "done"; result: CanonicalAsrResult };

/** What a best-effort remote cancellation achieved. */
export type AsrJobCancelOutcome = "cancelled" | "already_terminal" | "unsupported";

/** Invariant: the ASR boundary. Callers see only `CanonicalAsrResult`, never provider response types. */
export interface AsrSyncProvider {
  readonly id: string;
  readonly capabilities: AsrProviderCapabilities & { delivery: "sync" };
  transcribe(input: AsrTranscribeInput, opts: AsrTranscribeOptions): Promise<CanonicalAsrResult>;
}

/** Invariant: the ASR boundary, job form. Submit once, then query the job until it is done. */
export interface AsrJobProvider {
  readonly id: string;
  readonly capabilities: AsrProviderCapabilities & { delivery: "job" };
  submit(input: AsrTranscribeInput, opts: AsrSubmitOptions): Promise<AsrJobHandle>;
  /** One query; never waits for the job. Downloads and normalizes the result when it is ready. */
  poll(handle: AsrJobHandle, opts: { signal: AbortSignal }): Promise<AsrJobStatus>;
  cancel?(handle: AsrJobHandle, opts: { signal: AbortSignal }): Promise<AsrJobCancelOutcome>;
}

export type AsrProvider = AsrSyncProvider | AsrJobProvider;

export function isAsrJobProvider(provider: AsrProvider): provider is AsrJobProvider {
  return provider.capabilities.delivery === "job";
}

/** What a credential check learned about the account behind an ASR key. */
export interface AsrProbeResult {
  /** The upstream's subscription state, as reported (for example `active`). */
  subscriptionStatus?: string;
  /** Usage and limit in the provider's own billing unit for the current period. */
  usedUnits?: number;
  limitUnits?: number;
}

/**
 * What an adapter offers new profiles, so the service layer names no provider: the shared
 * preset (models, default model, endpoints and Base URL policy).
 */
export type AsrProviderDescriptor = AsrPreset;

/**
 * Builds providers from a user's ASR profile. The composition root maps
 * `profile.provider` to an adapter; the credential is revealed per call inside the adapter
 * and dropped afterwards.
 */
export interface AsrProviderFactory {
  readonly descriptor: AsrProviderDescriptor;
  /**
   * A provider for one model of the profile; its capabilities and request parameters are
   * those of the model's family (`asrModelFamily`). A model of the profile whose family does
   * not resolve, or a model not on the profile, fails with `asr_failed.model_unavailable`.
   */
  create(profile: AsrProviderProfile, modelId: string): AsrProvider;
  /**
   * "Test key": a free, read-only request that proves the key is accepted. It does not
   * depend on the profile's models or their order, and does not prove the account may use
   * them; the first real transcription does. An invalid key fails with `asr_failed.auth`.
   */
  probe(profile: AsrProviderProfile, signal: AbortSignal): Promise<AsrProbeResult>;
}
