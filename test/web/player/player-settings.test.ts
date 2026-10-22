import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { usePlayerSettings } from "../../../src/web/player/player-settings.ts";

describe("usePlayerSettings", () => {
  beforeEach(() => localStorage.clear());

  it("defaults to pausing at the end without autoplay", () => {
    const { result } = renderHook(() => usePlayerSettings());
    expect(result.current.endBehavior).toBe("pause");
    expect(result.current.autoplay).toBe(false);
  });

  it("writes every change through to local preferences and reads it back", () => {
    const first = renderHook(() => usePlayerSettings());
    act(() => first.result.current.setEndBehavior("loop_list"));
    act(() => first.result.current.setAutoplay(true));
    expect(first.result.current.endBehavior).toBe("loop_list");
    expect(first.result.current.autoplay).toBe(true);
    expect(localStorage.getItem("amber.player.endBehavior")).toBe("loop_list");
    expect(localStorage.getItem("amber.player.autoplay")).toBe("1");
    first.unmount();

    const second = renderHook(() => usePlayerSettings());
    expect(second.result.current.endBehavior).toBe("loop_list");
    expect(second.result.current.autoplay).toBe(true);
    act(() => second.result.current.setAutoplay(false));
    expect(localStorage.getItem("amber.player.autoplay")).toBe("0");
  });

  it("keeps reading the autoplay flag the player stored before", () => {
    localStorage.setItem("amber.player.autoplay", "1");
    expect(renderHook(() => usePlayerSettings()).result.current.autoplay).toBe(true);
  });

  it("falls back to pausing for an unknown stored end behaviour", () => {
    localStorage.setItem("amber.player.endBehavior", "shuffle");
    expect(renderHook(() => usePlayerSettings()).result.current.endBehavior).toBe("pause");
  });
});
