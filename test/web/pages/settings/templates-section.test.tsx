import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TemplatesSection } from "../../../../src/web/pages/settings/templates-section.tsx";
import { mockApi, renderApp } from "../../../fixtures/web/render.tsx";

describe("TemplatesSection", () => {
  it("shows builtin templates by their i18n name, read-only, without delete", async () => {
    mockApi({
      "GET /api/summary-templates": {
        body: {
          items: [
            { id: "summary.core", builtin: true, name: "summaryTemplate.core", currentVersion: 1, deleted: false },
            { id: "t1", builtin: false, name: "我的模板", currentVersion: 2, deleted: false },
          ],
        },
      },
      "GET /api/settings": { body: { theme: "light", language: "zh-CN", shortcuts: {}, updatedAt: 1 } },
      "GET /api/summary-templates/summary.core/versions": {
        body: { items: [{ templateId: "summary.core", version: 1, prompt: "PROMPT", createdAt: 1 }] },
      },
    });
    const { container } = renderApp(<TemplatesSection />);
    expect((await screen.findAllByText("核心总结")).length).toBeGreaterThan(0);
    const builtinRow = container.querySelector('[data-template="summary.core"]') as HTMLElement;
    const customRow = container.querySelector('[data-template="t1"]') as HTMLElement;
    expect(builtinRow.textContent).not.toContain("删除");
    expect(customRow.textContent).toContain("删除");
    fireEvent.click(builtinRow.querySelector("button") as HTMLElement);
    const prompt = (await screen.findByLabelText("提示词")) as HTMLTextAreaElement;
    expect(prompt.readOnly).toBe(true);
    expect(screen.getByText("内置模板不可修改")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "保存" })).toBeNull();
  });

  it("sets the default output language, which falls back to the interface language", async () => {
    const { calls } = mockApi({
      "GET /api/summary-templates": { body: { items: [] } },
      "GET /api/settings": { body: { theme: "light", language: "zh-CN", shortcuts: {}, updatedAt: 1 } },
      "PATCH /api/settings": { body: { theme: "light", language: "zh-CN", defaultOutputLanguage: "en", shortcuts: {}, updatedAt: 2 } },
    });
    renderApp(<TemplatesSection />);
    const select = (await screen.findByLabelText("默认输出语言")) as HTMLSelectElement;
    await waitFor(() => expect(select.selectedOptions[0]?.textContent).toBe("未设置 (简体中文)"));
    fireEvent.change(select, { target: { value: "en" } });
    await waitFor(() => expect(calls.find((call) => call.method === "PATCH" && call.path === "/api/settings")?.body).toEqual({ defaultOutputLanguage: "en" }));
  });
});
