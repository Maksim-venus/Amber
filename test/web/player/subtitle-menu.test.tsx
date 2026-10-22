import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { defaultSubtitleAppearance, defaultSubtitlePlacement } from "../../../src/shared/subtitle-style.ts";
import { SubtitleMenu } from "../../../src/web/player/subtitle-menu.tsx";
import type { SubtitleTrackModel } from "../../../src/web/player/subtitle-overlay.tsx";

function model(overrides: Partial<SubtitleTrackModel> = {}): SubtitleTrackModel {
  return {
    mode: "off",
    setMode: vi.fn(),
    originals: [
      { id: "r1", label: "平台字幕（当前）" },
      { id: "r2", label: "校对稿" },
    ],
    originalId: "r1",
    setOriginal: vi.fn(),
    translations: [],
    translationId: undefined,
    setTranslation: vi.fn(),
    goTranslate: vi.fn(),
    status: "off",
    retry: vi.fn(),
    slices: [],
    fontFallback: false,
    appearance: defaultSubtitleAppearance(),
    setAppearance: vi.fn(),
    resetAppearance: vi.fn(),
    placement: defaultSubtitlePlacement(),
    placementOverridden: false,
    setPlacement: vi.fn(),
    setDefaultPlacement: vi.fn(),
    resetPlacement: vi.fn(),
    editing: false,
    startEditing: vi.fn(),
    stopEditing: vi.fn(),
    ...overrides,
  };
}

function open(value: SubtitleTrackModel, onOpenChange?: (open: boolean) => void) {
  const container = document.createElement("div");
  document.body.append(container);
  render(<SubtitleMenu model={value} container={container} {...(onOpenChange === undefined ? {} : { onOpenChange })} />);
  fireEvent.keyDown(screen.getByTestId("player-subtitles"), { key: "Enter" });
  const menu = screen.getByTestId("player-subtitles-menu");
  expect(container.contains(menu)).toBe(true);
  return menu;
}

describe("SubtitleMenu", () => {
  it("offers the four display modes, the original revisions and 「去翻译」 without a translation", () => {
    const value = model();
    const onOpenChange = vi.fn();
    open(value, onOpenChange);
    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(screen.getAllByRole("menuitemradio").map((item) => item.textContent)).toEqual(["关闭", "仅原文", "仅译文", "双语", "平台字幕（当前）", "校对稿"]);
    expect(screen.getByTestId("player-subtitles-mode-off").getAttribute("aria-checked")).toBe("true");
    // Without a translation only the original can be shown.
    expect(screen.getByTestId("player-subtitles-mode-translation").hasAttribute("data-disabled")).toBe(true);
    expect(screen.getByTestId("player-subtitles-mode-bilingual").hasAttribute("data-disabled")).toBe(true);
    expect(screen.getByText("该版本还没有译文")).toBeTruthy();
    fireEvent.click(screen.getByTestId("player-subtitles-go-translate"));
    expect(value.goTranslate).toHaveBeenCalledTimes(1);
  });

  it("switches mode, revision and translation, and enters the editor", () => {
    const value = model({ mode: "original", translations: [{ id: "t1", label: "翻译 · 英语" }], translationId: "t1", fontFallback: true });
    open(value);
    expect(screen.getByTestId("player-subtitles").getAttribute("data-active")).toBe("true");
    fireEvent.click(screen.getByTestId("player-subtitles-mode-bilingual"));
    expect(value.setMode).toHaveBeenCalledWith("bilingual");
    fireEvent.keyDown(screen.getByTestId("player-subtitles"), { key: "Enter" });
    expect(screen.queryByTestId("player-subtitles-go-translate")).toBeNull();
    expect(screen.getByText("预览字体与导出不同")).toBeTruthy();
    fireEvent.click(screen.getByTestId("player-subtitles-original-r2"));
    expect(value.setOriginal).toHaveBeenCalledWith("r2");
    fireEvent.keyDown(screen.getByTestId("player-subtitles"), { key: "Enter" });
    expect(screen.getByTestId("player-subtitles-translation-t1").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByTestId("player-subtitles-edit"));
    expect(value.startEditing).toHaveBeenCalledTimes(1);
  });
});
