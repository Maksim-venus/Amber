import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { effectiveShortcuts, normalizeShortcut, SHORTCUT_ACTIONS, type ShortcutAction } from "../shared/shortcuts.ts";

/**
 * Normalizes a key event to the `Ctrl+Shift+O` notation of the named defaults. The physical
 * `code` is used so Shift or the keyboard layout does not change the letter.
 */
export function comboOf(event: Pick<KeyboardEvent, "ctrlKey" | "altKey" | "shiftKey" | "metaKey" | "code">): string {
  const parts: string[] = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  if (event.metaKey) parts.push("Meta");
  parts.push(keyOf(event.code));
  return parts.join("+");
}

const CODE_KEYS: Readonly<Record<string, string>> = {
  Slash: "/",
  Backslash: "\\",
  Period: ".",
  Comma: ",",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Minus: "-",
  Equal: "=",
  Backquote: "`",
};

/**
 * The notation of a blocked browser key: letters by the logical key (what WebView2 matches
 * its accelerators on, so `Ctrl+F` follows the layout), everything else by `code`.
 */
export function blockedComboOf(event: Pick<KeyboardEvent, "ctrlKey" | "altKey" | "shiftKey" | "metaKey" | "code" | "key">): string {
  const parts: string[] = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  if (event.metaKey) parts.push("Meta");
  parts.push(/^[a-z]$/i.test(event.key) ? event.key.toUpperCase() : keyOf(event.code));
  return parts.join("+");
}

/**
 * Whether a key event carries Ctrl, Meta or Alt. Component-local key handling (the local
 * player's keys) leaves such combinations to the registry and the browser.
 */
export function hasCommandModifier(event: Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "altKey">): boolean {
  return event.ctrlKey || event.metaKey || event.altKey;
}

function keyOf(code: string): string {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  return CODE_KEYS[code] ?? code;
}

type Handler = () => void;

/**
 * The only place global shortcuts are bound. One capture-phase listener on
 * the window maps a combination to its action; the most recently registered handler of
 * that action runs. Unbound or unhandled combinations reach the page untouched.
 */
export class ShortcutRegistry {
  private bindings: Record<ShortcutAction, string> = effectiveShortcuts({});
  private readonly handlers = new Map<ShortcutAction, Handler[]>();
  private suspensions = 0;
  private readonly blocked = new Map<string, number>();

  setOverrides(overrides: Partial<Record<ShortcutAction, string>>): void {
    this.bindings = effectiveShortcuts(overrides);
  }

  binding(action: ShortcutAction): string {
    return this.bindings[action];
  }

  list(): Array<{ action: ShortcutAction; combo: string }> {
    return SHORTCUT_ACTIONS.map((action) => ({ action, combo: this.bindings[action] }));
  }

  on(action: ShortcutAction, handler: Handler): () => void {
    const list = this.handlers.get(action) ?? [];
    list.push(handler);
    this.handlers.set(action, list);
    return () => {
      const current = this.handlers.get(action) ?? [];
      this.handlers.set(
        action,
        current.filter((item) => item !== handler),
      );
    };
  }

  /**
   * Lets every combination through until the returned function is called, e.g. while a
   * settings field records a new binding. Nested suspensions stack.
   */
  suspend(): () => void {
    this.suspensions += 1;
    let resumed = false;
    return () => {
      if (!resumed) {
        resumed = true;
        this.suspensions -= 1;
      }
    };
  }

  /**
   * Keeps the browser from acting on these combinations (`preventDefault` only, so key
   * recorders and other listeners still see them) until the returned function is called.
   * A bound action wins over a block; suspensions do not lift it.
   */
  block(combos: readonly string[]): () => void {
    const normalized = combos.map((combo) => normalizeShortcut(combo)).filter((combo): combo is string => combo !== undefined);
    for (const combo of normalized) this.blocked.set(combo, (this.blocked.get(combo) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const combo of normalized) {
        const count = (this.blocked.get(combo) ?? 0) - 1;
        if (count <= 0) this.blocked.delete(combo);
        else this.blocked.set(combo, count);
      }
    };
  }

  /** Whether a block covers this event. */
  isBlocked(event: Pick<KeyboardEvent, "ctrlKey" | "altKey" | "shiftKey" | "metaKey" | "code" | "key">): boolean {
    if (this.blocked.size === 0) return false;
    const combo = normalizeShortcut(blockedComboOf(event));
    return combo !== undefined && this.blocked.has(combo);
  }

  /** The action bound to this event, if any handler would take it. */
  match(event: Pick<KeyboardEvent, "ctrlKey" | "altKey" | "shiftKey" | "metaKey" | "code">): ShortcutAction | undefined {
    const combo = normalizeShortcut(comboOf(event));
    if (combo === undefined) {
      return undefined;
    }
    return SHORTCUT_ACTIONS.find((action) => normalizeShortcut(this.bindings[action]) === combo && (this.handlers.get(action)?.length ?? 0) > 0);
  }

  attach(target: Pick<Window, "addEventListener" | "removeEventListener">): () => void {
    const listener = (event: KeyboardEvent): void => {
      const action = this.suspensions > 0 ? undefined : this.match(event);
      if (action === undefined) {
        if (this.isBlocked(event)) event.preventDefault();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      this.handlers.get(action)?.at(-1)?.();
    };
    target.addEventListener("keydown", listener, { capture: true });
    return () => target.removeEventListener("keydown", listener, { capture: true });
  }
}

const RegistryContext = createContext<ShortcutRegistry | undefined>(undefined);

export function ShortcutProvider(props: { overrides: Partial<Record<ShortcutAction, string>>; children: ReactNode }) {
  const [registry] = useState(() => new ShortcutRegistry());
  registry.setOverrides(props.overrides);
  useEffect(() => registry.attach(window), [registry]);
  return <RegistryContext.Provider value={registry}>{props.children}</RegistryContext.Provider>;
}

export function useShortcutRegistry(): ShortcutRegistry {
  const registry = useContext(RegistryContext);
  if (registry === undefined) {
    throw new Error("ShortcutProvider missing");
  }
  return registry;
}

/** Blocks browser key combinations while the calling component is mounted and `enabled`. */
export function useBlockedKeys(combos: readonly string[], enabled: boolean): void {
  const registry = useShortcutRegistry();
  useEffect(() => (enabled ? registry.block(combos) : undefined), [registry, combos, enabled]);
}

/** Binds a handler to an action for the lifetime of the calling component. */
export function useShortcut(action: ShortcutAction, handler: Handler): void {
  const registry = useShortcutRegistry();
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => registry.on(action, () => latest.current()), [registry, action]);
}
