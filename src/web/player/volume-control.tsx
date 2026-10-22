import { Volume1, Volume2, VolumeX } from "lucide-react";
import { type CSSProperties, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

const VOLUME_KEY = "amber.player.volume";
const MUTED_KEY = "amber.player.muted";

/** The stored volume (0–1, full when unset or unreadable) and mute flag. */
function storedVolume(): { volume: number; muted: boolean } {
  const raw = localStorage.getItem(VOLUME_KEY);
  const parsed = raw === null ? Number.NaN : Number(raw);
  return { volume: Number.isFinite(parsed) ? clampVolume(parsed) : 1, muted: localStorage.getItem(MUTED_KEY) === "1" };
}

/** Clamps to 0–1 and rounds to whole percent, so repeated steps do not drift. */
function clampVolume(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 100) / 100;
}

export interface VolumeSetting {
  volume: number;
  muted: boolean;
  /** Sets the level; a level above zero also lifts mute, as turning the knob does. */
  setVolume: (volume: number) => void;
  toggleMute: () => void;
}

/** The local player's volume and mute state, kept in local UI preferences. */
export function useVolumeSetting(): VolumeSetting {
  const [state, setState] = useState(storedVolume);
  const setVolume = useCallback((value: number) => {
    setState((current) => {
      const volume = clampVolume(value);
      const muted = volume > 0 ? false : current.muted;
      localStorage.setItem(VOLUME_KEY, String(volume));
      localStorage.setItem(MUTED_KEY, muted ? "1" : "0");
      return { volume, muted };
    });
  }, []);
  const toggleMute = useCallback(() => {
    setState((current) => {
      localStorage.setItem(MUTED_KEY, current.muted ? "0" : "1");
      return { ...current, muted: !current.muted };
    });
  }, []);
  return { ...state, setVolume, toggleMute };
}

/**
 * The speaker button of the control bar: a click mutes or unmutes; hovering it or focusing
 * inside shows a vertical volume slider above it. The slider stays inside the player, so it
 * is shown in fullscreen too.
 */
export function VolumeControl(props: { setting: VolumeSetting }) {
  const { t } = useTranslation();
  const { volume, muted, setVolume, toggleMute } = props.setting;
  const level = muted ? 0 : volume;
  const percent = Math.round(level * 100);
  const Icon = level === 0 ? VolumeX : level < 0.5 ? Volume1 : Volume2;
  return (
    <div className="group relative flex" data-testid="player-volume">
      <div
        className="absolute bottom-full left-1/2 hidden -translate-x-1/2 pb-2 group-focus-within:flex group-hover:flex"
        data-testid="player-volume-popover"
      >
        <div className="flex w-5.5 flex-col items-center gap-1 rounded-md bg-black/80 py-1.5 text-[10px] leading-none text-white">
          <span className="font-mono tabular-nums" data-testid="player-volume-percent">
            {percent}
          </span>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={percent}
            aria-label={t("contentView.player.volume")}
            className="volume-range h-20 w-2.5 cursor-pointer"
            style={{ "--volume-fill": `${percent}%` } as CSSProperties}
            onChange={(event) => setVolume(Number(event.target.value) / 100)}
            data-testid="player-volume-range"
          />
        </div>
      </div>
      <button
        type="button"
        className="player-button"
        aria-label={muted ? t("contentView.player.unmute") : t("contentView.player.mute")}
        title={muted ? t("contentView.player.unmute") : t("contentView.player.mute")}
        onClick={toggleMute}
        data-testid="player-mute"
      >
        <Icon size={18} />
      </button>
    </div>
  );
}
