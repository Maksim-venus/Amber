import { useCallback, useState } from "react";
import { PLAYER_END_BEHAVIORS, type PlayerEndBehavior } from "../../shared/enums.ts";

/** What the local player does when it reaches the end: pause (the default), repeat this Content, or loop its list. */
export const END_BEHAVIORS = PLAYER_END_BEHAVIORS;
export type EndBehavior = PlayerEndBehavior;

export interface PlayerSettings {
  endBehavior: EndBehavior;
  setEndBehavior(value: EndBehavior): void;
  autoplay: boolean;
  setAutoplay(value: boolean): void;
}

const END_BEHAVIOR_KEY = "amber.player.endBehavior";
/** Stored as "1" / "0", the format the player has always written. */
const AUTOPLAY_KEY = "amber.player.autoplay";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Storage can be unavailable (private mode): the choice then lasts for the session only. */
function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not remembered; the player keeps working.
  }
}

function storedEndBehavior(): EndBehavior {
  const stored = read(END_BEHAVIOR_KEY);
  return END_BEHAVIORS.find((option) => option === stored) ?? "pause";
}

/** The local player's settings menu state, kept in local UI preferences. */
export function usePlayerSettings(): PlayerSettings {
  const [endBehavior, setEndBehaviorState] = useState<EndBehavior>(storedEndBehavior);
  const [autoplay, setAutoplayState] = useState(() => read(AUTOPLAY_KEY) === "1");
  const setEndBehavior = useCallback((value: EndBehavior) => {
    setEndBehaviorState(value);
    remember(END_BEHAVIOR_KEY, value);
  }, []);
  const setAutoplay = useCallback((value: boolean) => {
    setAutoplayState(value);
    remember(AUTOPLAY_KEY, value ? "1" : "0");
  }, []);
  return { endBehavior, setEndBehavior, autoplay, setAutoplay };
}
