import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SAVE_NOTICE_DISMISS_MS } from "../../src/shared/defaults.ts";
import { useAutoDismiss } from "../../src/web/use-auto-dismiss.ts";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useAutoDismiss", () => {
  it("dismisses a notice once SAVE_NOTICE_DISMISS_MS has passed, not before", () => {
    const onDismiss = vi.fn();
    renderHook(() => useAutoDismiss("D:\\a.mp4", onDismiss));
    act(() => vi.advanceTimersByTime(SAVE_NOTICE_DISMISS_MS - 1));
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("waits for nothing while there is no notice", () => {
    const onDismiss = vi.fn();
    renderHook(() => useAutoDismiss(undefined, onDismiss));
    act(() => vi.advanceTimersByTime(SAVE_NOTICE_DISMISS_MS * 2));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("restarts the wait for a new notice and calls the latest callback", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook((props: { key: string; onDismiss: () => void }) => useAutoDismiss(props.key, props.onDismiss), {
      initialProps: { key: "a", onDismiss: first },
    });
    act(() => vi.advanceTimersByTime(SAVE_NOTICE_DISMISS_MS - 10));
    rerender({ key: "b", onDismiss: second });
    act(() => vi.advanceTimersByTime(SAVE_NOTICE_DISMISS_MS - 1));
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("keeps the running wait when only the callback changes", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook((props: { onDismiss: () => void }) => useAutoDismiss("a", props.onDismiss), { initialProps: { onDismiss: first } });
    act(() => vi.advanceTimersByTime(SAVE_NOTICE_DISMISS_MS - 1));
    rerender({ onDismiss: second });
    act(() => vi.advanceTimersByTime(1));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("cancels the wait when the notice goes early or the component unmounts", () => {
    const onDismiss = vi.fn();
    const { rerender, unmount } = renderHook((props: { key: string | undefined }) => useAutoDismiss(props.key, onDismiss), { initialProps: { key: "a" as string | undefined } });
    rerender({ key: undefined });
    act(() => vi.advanceTimersByTime(SAVE_NOTICE_DISMISS_MS));
    expect(onDismiss).not.toHaveBeenCalled();
    rerender({ key: "b" });
    unmount();
    act(() => vi.advanceTimersByTime(SAVE_NOTICE_DISMISS_MS));
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
