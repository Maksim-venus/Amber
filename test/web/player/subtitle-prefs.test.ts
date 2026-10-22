import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { defaultSubtitleAppearance, defaultSubtitlePlacement } from "../../../src/shared/subtitle-style.ts";
import {
  readAppearance,
  readPlacement,
  readTrack,
  resetSubtitlePrefsMemory,
  subtitlePrefKeys,
  useSubtitlePrefs,
  writeDefaultPlacement,
  writePlacement,
} from "../../../src/web/player/subtitle-prefs.ts";

const moved = { version: 1 as const, xBp: 1500, yBp: 2000, anchor: "top" as const };

describe("subtitle preferences", () => {
  beforeEach(() => {
    localStorage.clear();
    resetSubtitlePrefsMemory();
  });

  it("starts with subtitles off and the system defaults", () => {
    expect(readTrack("u1", "c1")).toEqual({ version: 1, mode: "off" });
    expect(readAppearance("u1")).toEqual(defaultSubtitleAppearance());
    expect(readPlacement("u1", "c1")).toEqual(defaultSubtitlePlacement());
  });

  it("falls back to defaults for damaged or outdated entries", () => {
    localStorage.setItem(subtitlePrefKeys.appearance("u1"), "{not json");
    localStorage.setItem(subtitlePrefKeys.placement("u1", "c1"), JSON.stringify({ ...moved, version: 0 }));
    localStorage.setItem(subtitlePrefKeys.track("u1", "c1"), JSON.stringify({ version: 1, mode: "karaoke" }));
    expect(readAppearance("u1")).toEqual(defaultSubtitleAppearance());
    expect(readPlacement("u1", "c1")).toEqual(defaultSubtitlePlacement());
    expect(readTrack("u1", "c1").mode).toBe("off");
  });

  it("resolves placement as content override, then user default, then system default", () => {
    writeDefaultPlacement("u1", { ...moved, anchor: "center", yBp: 5000 });
    expect(readPlacement("u1", "c1")).toMatchObject({ anchor: "center", yBp: 5000 });
    writePlacement("u1", "c1", moved);
    expect(readPlacement("u1", "c1")).toEqual(moved);
    expect(readPlacement("u1", "c2")).toMatchObject({ anchor: "center" });
  });

  it("keeps users apart in one browser", () => {
    writePlacement("u1", "c1", moved);
    expect(readPlacement("u2", "c1")).toEqual(defaultSubtitlePlacement());
  });

  it("gives every hook the same values after a write and resets with the documented scope", () => {
    const player = renderHook(() => useSubtitlePrefs("u1", "c1"));
    const dialog = renderHook(() => useSubtitlePrefs("u1", "c1"));
    const before = player.result.current.appearance;
    act(() => player.result.current.setPlacement(moved));
    expect(dialog.result.current.placement).toEqual(moved);
    expect(dialog.result.current.placementOverridden).toBe(true);
    expect(player.result.current.appearance).toBe(player.result.current.appearance);

    act(() => player.result.current.setDefaultPlacement());
    act(() => player.result.current.resetPlacement());
    expect(dialog.result.current.placementOverridden).toBe(false);
    expect(dialog.result.current.placement).toEqual(moved);

    act(() => player.result.current.setAppearance({ ...before, original: { fontSize: 60, color: "#FF0000" } }));
    expect(dialog.result.current.appearance.original).toEqual({ fontSize: 60, color: "#FF0000" });
    act(() => player.result.current.resetAppearance());
    expect(dialog.result.current.appearance).toEqual(defaultSubtitleAppearance());
    expect(dialog.result.current.placement).toEqual(moved);
  });
});
