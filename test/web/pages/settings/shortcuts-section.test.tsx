import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ShortcutsSection } from "../../../../src/web/pages/settings/shortcuts-section.tsx";
import { mockApi, renderApp } from "../../../fixtures/web/render.tsx";

const SETTINGS = { theme: "light", language: "zh-CN", shortcuts: {}, updatedAt: 1 };

async function capture(action: string, init: KeyboardEventInit & { code: string; key: string }) {
  const button = await screen.findByRole("button", { name: new RegExp(`^${action} `) });
  fireEvent.click(button);
  const field = screen.getByLabelText(action);
  fireEvent.keyDown(field, init);
}

describe("ShortcutsSection", () => {
  it("rejects a reserved combination and keeps save disabled", async () => {
    const api = mockApi({ "GET /api/settings": { body: SETTINGS } });
    renderApp(<ShortcutsSection />);
    await capture("打开命令面板", { code: "KeyT", key: "t", ctrlKey: true });
    expect(await screen.findByText("这是浏览器或系统保留的按键")).toBeTruthy();
    expect((screen.getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled).toBe(true);
    expect(api.calls.some((call) => call.method === "PATCH")).toBe(false);
  });

  it("puts save under the block, right-aligned, outside it", async () => {
    mockApi({ "GET /api/settings": { body: SETTINGS } });
    renderApp(<ShortcutsSection />);
    const save = await screen.findByRole("button", { name: "保存" });
    const block = (await screen.findByRole("table")).closest("section") as HTMLElement;
    expect(block.contains(save)).toBe(false);
    const actions = screen.getByTestId("shortcuts-actions");
    expect(actions.contains(save)).toBe(true);
    expect(block.nextElementSibling).toBe(actions);
    expect(actions.className).toContain("justify-end");
  });

  it("flags a combination already used by another action", async () => {
    mockApi({ "GET /api/settings": { body: SETTINGS } });
    renderApp(<ShortcutsSection />);
    await capture("快捷键表", { code: "KeyO", key: "O", ctrlKey: true, shiftKey: true });
    expect((await screen.findAllByText("与其它动作冲突")).length).toBe(2);
  });

  it("saves a valid combination and resets an override with null", async () => {
    const api = mockApi({
      "GET /api/settings": { body: { ...SETTINGS, shortcuts: { shortcutHelp: "Alt+H" } } },
      "PATCH /api/settings": (call) => ({ body: { ...SETTINGS, shortcuts: call.body } }),
    });
    renderApp(<ShortcutsSection />);
    await capture("打开命令面板", { code: "KeyK", key: "k", altKey: true });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(api.calls.find((call) => call.method === "PATCH")?.body).toEqual({ shortcuts: { omnibox: "Alt+K" } }));
    const resets = screen.getAllByRole("button", { name: "恢复默认" });
    fireEvent.click(resets[2] as HTMLElement);
    await waitFor(() => expect(api.calls.filter((call) => call.method === "PATCH").at(-1)?.body).toEqual({ shortcuts: { shortcutHelp: null } }));
  });
});
