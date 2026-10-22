import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";
import { CAPABILITIES, type PlayerCapabilities } from "./capabilities.ts";

/** What a concrete player plugs into the controller. */
export interface PlayerDriver {
  capabilities: PlayerCapabilities;
  seek(ms: number): void;
}

type Listener = () => void;

/**
 * The page-wide handle to whichever player is mounted: citations, chapters and sentences
 * call `seek`; players report their time, which only exists when time tracking is
 * supported. With no player mounted, seeking is remembered and applied on attach.
 */
export class PlayerController {
  private driver: PlayerDriver | undefined;
  private pendingSeekMs: number | undefined;
  private timeMs: number | undefined;
  private readonly listeners = new Set<Listener>();

  get capabilities(): PlayerCapabilities {
    return this.driver?.capabilities ?? CAPABILITIES.none;
  }

  attach(driver: PlayerDriver): () => void {
    this.driver = driver;
    this.timeMs = undefined;
    if (this.pendingSeekMs !== undefined && driver.capabilities.seekMode !== "unsupported") {
      driver.seek(this.pendingSeekMs);
      this.pendingSeekMs = undefined;
    }
    this.emit();
    return () => {
      if (this.driver === driver) {
        this.driver = undefined;
        this.timeMs = undefined;
        this.emit();
      }
    };
  }

  seek(ms: number): void {
    if (this.driver === undefined) {
      this.pendingSeekMs = ms;
      return;
    }
    if (this.driver.capabilities.seekMode !== "unsupported") {
      this.driver.seek(ms);
    }
  }

  /** Called by players that track time; ignored for those that cannot. */
  reportTime(ms: number): void {
    if (this.driver?.capabilities.timeTracking !== "supported" || ms === this.timeMs) {
      return;
    }
    this.timeMs = ms;
    this.emit();
  }

  currentTimeMs(): number | undefined {
    return this.capabilities.timeTracking === "supported" ? this.timeMs : undefined;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

const ControllerContext = createContext<PlayerController | undefined>(undefined);

export function PlayerControllerProvider(props: { controller: PlayerController; children: ReactNode }) {
  return <ControllerContext.Provider value={props.controller}>{props.children}</ControllerContext.Provider>;
}

export function usePlayerController(): PlayerController {
  const controller = useContext(ControllerContext);
  if (controller === undefined) {
    throw new Error("PlayerControllerProvider missing");
  }
  return controller;
}

/** Current playback time, or undefined when the player cannot report it. */
export function usePlayerTime(): number | undefined {
  const controller = usePlayerController();
  return useSyncExternalStore(
    (listener) => controller.subscribe(listener),
    () => controller.currentTimeMs(),
  );
}

export function usePlayerCapabilities(): PlayerCapabilities {
  const controller = usePlayerController();
  return useSyncExternalStore(
    (listener) => controller.subscribe(listener),
    () => controller.capabilities,
  );
}
