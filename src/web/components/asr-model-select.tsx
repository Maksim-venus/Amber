import { useTranslation } from "react-i18next";
import type { AsrProfileDto } from "../../shared/dto/asr-profile.ts";
import type { AsrModelRefDto } from "../../shared/dto/model-ref.ts";

/** The value an ASR model takes in a `<select>`; "" stands for none chosen. */
export function encodeAsrModel(ref: AsrModelRefDto): string {
  return JSON.stringify([ref.asrProfileId, ref.modelId]);
}

export function decodeAsrModel(value: string): AsrModelRefDto | undefined {
  if (value === "") return undefined;
  try {
    const [asrProfileId, modelId] = JSON.parse(value) as [string, string];
    return { asrProfileId, modelId };
  } catch {
    return undefined;
  }
}

/** Whether the reference names a model its profile lists and its provider still offers. */
export function isPickableAsrModel(profiles: readonly AsrProfileDto[], ref: AsrModelRefDto | undefined): ref is AsrModelRefDto {
  if (ref === undefined) return false;
  const profile = profiles.find((item) => item.id === ref.asrProfileId);
  return profile?.models.some((model) => model.modelId === ref.modelId && model.available) === true;
}

/**
 * The model an ASR picker starts with: the user's default while it can still
 * be picked, else none. It never falls back to the first listed model: a model is only used
 * when the user chose it, here or as the default.
 */
export function initialAsrModelRef(profiles: readonly AsrProfileDto[], defaultRef: AsrModelRefDto | undefined): AsrModelRefDto | undefined {
  return isPickableAsrModel(profiles, defaultRef) ? defaultRef : undefined;
}

/** Every pickable model as "profile · model", in the user's profile order and then model order. */
export function asrModelOptions(profiles: readonly AsrProfileDto[]): Array<{ ref: AsrModelRefDto; value: string; label: string }> {
  return profiles.flatMap((profile) =>
    profile.models
      .filter((model) => model.available)
      .map((model) => {
        const ref = { asrProfileId: profile.id, modelId: model.modelId };
        return { ref, value: encodeAsrModel(ref), label: `${profile.name} · ${model.modelId}` };
      }),
  );
}

/** "Profile · model" while the profile exists, else "service · model (profile deleted)". */
export function useAsrModelLabel(): (ref: AsrModelRefDto, profiles: readonly AsrProfileDto[], provider?: string) => string {
  const { t } = useTranslation();
  return (ref, profiles, provider) => {
    const profile = profiles.find((item) => item.id === ref.asrProfileId);
    if (profile !== undefined) {
      return `${profile.name} · ${ref.modelId}`;
    }
    const service = provider === undefined ? undefined : t(`settings.transcription.providers.${provider}`, { defaultValue: provider });
    return t("shell.flow.asrEngineDeleted", { engine: service === undefined ? ref.modelId : `${service} · ${ref.modelId}` });
  };
}

/**
 * A select over the user's pickable ASR models. With `noneLabel` its first option chooses
 * none; without it, an unset value shows `placeholder` until the user picks.
 */
export function AsrModelSelect(props: {
  profiles: readonly AsrProfileDto[];
  value: AsrModelRefDto | undefined;
  onChange: (ref: AsrModelRefDto | undefined) => void;
  label: string;
  noneLabel?: string;
  placeholder?: string;
  /** Shown for a current value that is not (or no longer) pickable, so it stays selected. */
  currentLabel?: string;
  className?: string;
  testId?: string;
  disabled?: boolean;
}) {
  const options = asrModelOptions(props.profiles);
  const value = props.value === undefined ? "" : encodeAsrModel(props.value);
  const listed = value === "" || options.some((option) => option.value === value);
  return (
    <select
      aria-label={props.label}
      className={props.className ?? "h-8 rounded-md border border-line bg-surface px-2 text-sm"}
      value={value}
      disabled={props.disabled}
      data-testid={props.testId}
      onChange={(event) => props.onChange(decodeAsrModel(event.target.value))}
    >
      {props.noneLabel !== undefined ? (
        <option value="">{props.noneLabel}</option>
      ) : value === "" ? (
        <option value="" disabled>
          {props.placeholder ?? ""}
        </option>
      ) : null}
      {listed ? null : <option value={value}>{props.currentLabel ?? props.value?.modelId}</option>}
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
