import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SHORTCUT_NEW_SUMMARY_DEFAULT, SHORTCUT_OMNIBOX_DEFAULT } from "../../src/shared/defaults.ts";
import { DESKTOP_BLOCKED_BROWSER_KEYS } from "../../src/shared/shortcuts.ts";
import { blockedComboOf, comboOf, ShortcutProvider, ShortcutRegistry, useShortcut } from "../../src/web/shortcut-registry.tsx";

const key = (code: string, modifiers: Partial<Record<"ctrlKey" | "altKey" | "shiftKey" | "metaKey", boolean>> = {}) => ({
  code,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...modifiers,
});

describe("comboOf", () => {
  it("uses the default shortcuts' notation from physical key codes", () => {
    expect(comboOf(key("KeyK", { ctrlKey: true }))).toBe(SHORTCUT_OMNIBOX_DEFAULT);
    expect(comboOf(key("KeyO", { ctrlKey: true, shiftKey: true }))).toBe(SHORTCUT_NEW_SUMMARY_DEFAULT);
    expect(comboOf(key("Slash", { ctrlKey: true }))).toBe("Ctrl+/");
  });
});

describe("ShortcutRegistry", () => {
  it("claims only bound combinations that have a handler, newest handler first", () => {
    const registry = new ShortcutRegistry();
    const first = vi.fn();
    const second = vi.fn();
    registry.on("omnibox", first);
    const off = registry.on("omnibox", second);
    const detach = registry.attach(window);

    const event = new KeyboardEvent("keydown", { code: "KeyK", ctrlKey: true, cancelable: true });
    window.dispatchEvent(event);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);

    off();
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyK", ctrlKey: true }));
    expect(first).toHaveBeenCalledTimes(1);

    // No handler for newSummary: the browser keeps the key.
    const unclaimed = new KeyboardEvent("keydown", { code: "KeyO", ctrlKey: true, shiftKey: true, cancelable: true });
    window.dispatchEvent(unclaimed);
    expect(unclaimed.defaultPrevented).toBe(false);
    detach();
  });

  it("lets every combination through while suspended", () => {
    const registry = new ShortcutRegistry();
    const handler = vi.fn();
    registry.on("omnibox", handler);
    const detach = registry.attach(window);
    const resume = registry.suspend();
    const event = new KeyboardEvent("keydown", { code: "KeyK", ctrlKey: true, cancelable: true });
    window.dispatchEvent(event);
    expect(handler).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    resume();
    resume();
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyK", ctrlKey: true }));
    expect(handler).toHaveBeenCalledTimes(1);
    detach();
  });

  it("follows the user's overrides", () => {
    const registry = new ShortcutRegistry();
    registry.setOverrides({ omnibox: "Alt+K" });
    registry.on("omnibox", () => undefined);
    expect(registry.match(key("KeyK", { altKey: true }))).toBe("omnibox");
    expect(registry.match(key("KeyK", { ctrlKey: true }))).toBeUndefined();
  });
});

describe("useShortcut", () => {
  function Probe(props: { onHit: () => void }) {
    useShortcut("shortcutHelp", props.onHit);
    return null;
  }

  it("binds for the component's lifetime", () => {
    const onHit = vi.fn();
    const view = render(
      <ShortcutProvider overrides={{}}>
        <Probe onHit={onHit} />
      </ShortcutProvider>,
    );
    fireEvent.keyDown(window, { code: "Slash", ctrlKey: true });
    expect(onHit).toHaveBeenCalledTimes(1);
    view.unmount();
    fireEvent.keyDown(window, { code: "Slash", ctrlKey: true });
    expect(onHit).toHaveBeenCalledTimes(1);
  });
});

describe("ShortcutRegistry.block", () => {
  const press = (init: KeyboardEventInit): KeyboardEvent => {
    const event = new KeyboardEvent("keydown", { cancelable: true, bubbles: true, ...init });
    window.dispatchEvent(event);
    return event;
  };

  it("prevents the browser default without stopping propagation, also while suspended", () => {
    const registry = new ShortcutRegistry();
    const detach = registry.attach(window);
    const release = registry.block(DESKTOP_BLOCKED_BROWSER_KEYS);
    const seen = vi.fn();
    window.addEventListener("keydown", seen);
    expect(press({ code: "F5", key: "F5" }).defaultPrevented).toBe(true);
    expect(press({ code: "KeyR", key: "r", ctrlKey: true }).defaultPrevented).toBe(true);
    expect(press({ code: "KeyF", key: "f", ctrlKey: true }).defaultPrevented).toBe(true);
    expect(press({ code: "BrowserRefresh", key: "BrowserRefresh" }).defaultPrevented).toBe(true);
    expect(seen).toHaveBeenCalledTimes(4);
    const resume = registry.suspend();
    expect(press({ code: "KeyP", key: "p", ctrlKey: true }).defaultPrevented).toBe(true);
    resume();
    // Zoom and Ctrl+S are not in the table.
    expect(press({ code: "Equal", key: "=", ctrlKey: true }).defaultPrevented).toBe(false);
    expect(press({ code: "KeyS", key: "s", ctrlKey: true }).defaultPrevented).toBe(false);
    release();
    expect(press({ code: "F5", key: "F5" }).defaultPrevented).toBe(false);
    window.removeEventListener("keydown", seen);
    detach();
  });

  it("lets a user binding on a blocked key win", () => {
    const registry = new ShortcutRegistry();
    registry.setOverrides({ omnibox: "F5" });
    const handler = vi.fn();
    registry.on("omnibox", handler);
    const detach = registry.attach(window);
    registry.block(["F5"]);
    press({ code: "F5", key: "F5" });
    expect(handler).toHaveBeenCalledTimes(1);
    detach();
  });

  it("matches letters by the logical key", () => {
    // AZERTY: the key printing "f" sits where QWERTY has another letter.
    expect(blockedComboOf({ code: "KeyQ", key: "f", ctrlKey: true, altKey: false, shiftKey: false, metaKey: false })).toBe("Ctrl+F");
    expect(blockedComboOf({ code: "F3", key: "F3", ctrlKey: false, altKey: false, shiftKey: true, metaKey: false })).toBe("Shift+F3");
  });
});
