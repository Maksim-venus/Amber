import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EditCollectionDialog } from "../../../../src/web/components/collection/edit-collection-dialog.tsx";
import { collectionDetail } from "../../../fixtures/web/shell-data.ts";
import { mockApi, renderApp } from "../../../fixtures/web/render.tsx";

const target = { id: "k1", name: "旧合集名", description: "旧说明" };
const refused = { status: 404, body: { error: { class: "not_found", code: "not_found", retryDisposition: "never", userMessage: "合集不存在" } } };

describe("EditCollectionDialog", () => {
  it("prefills name and description and sends only the trimmed name when that is all that changed", async () => {
    const onOpenChange = vi.fn();
    const { calls } = mockApi({ "PATCH /api/collections/k1": { body: collectionDetail("k1", "新合集名", []) } });
    renderApp(<EditCollectionDialog collection={target} onOpenChange={onOpenChange} />);
    const input = (await screen.findByLabelText("合集名称")) as HTMLInputElement;
    expect(screen.getByRole("dialog", { name: "编辑合集" })).toBeTruthy();
    expect(input.value).toBe("旧合集名");
    expect(document.activeElement).toBe(input);
    expect((screen.getByLabelText("说明（可选）") as HTMLTextAreaElement).value).toBe("旧说明");
    fireEvent.change(input, { target: { value: "   " } });
    expect((screen.getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: " 新合集名 " } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({ name: "新合集名" });
  });

  it("sends the trimmed new description, keeping its line breaks", async () => {
    const onOpenChange = vi.fn();
    const { calls } = mockApi({ "PATCH /api/collections/k1": { body: collectionDetail("k1", "旧合集名", []) } });
    renderApp(<EditCollectionDialog collection={target} onOpenChange={onOpenChange} />);
    fireEvent.change(await screen.findByLabelText("说明（可选）"), { target: { value: " 第一行\n第二行 " } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({ description: "第一行\n第二行" });
  });

  it("clears an emptied description with null", async () => {
    const onOpenChange = vi.fn();
    const { calls } = mockApi({ "PATCH /api/collections/k1": { body: collectionDetail("k1", "旧合集名", []) } });
    renderApp(<EditCollectionDialog collection={target} onOpenChange={onOpenChange} />);
    fireEvent.change(await screen.findByLabelText("说明（可选）"), { target: { value: "  " } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({ description: null });
  });

  it("closes without a request when nothing changed", async () => {
    const onOpenChange = vi.fn();
    const { calls } = mockApi({});
    renderApp(<EditCollectionDialog collection={{ id: "k1", name: "旧合集名" }} onOpenChange={onOpenChange} />);
    fireEvent.change(await screen.findByLabelText("说明（可选）"), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(calls).toHaveLength(0);
  });

  it("keeps the dialog open with the reason when the change is refused", async () => {
    const onOpenChange = vi.fn();
    mockApi({ "PATCH /api/collections/k1": refused });
    renderApp(<EditCollectionDialog collection={target} onOpenChange={onOpenChange} />);
    fireEvent.change(await screen.findByLabelText("合集名称"), { target: { value: "新合集名" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByText("合集不存在")).toBeTruthy();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("renders nothing without a collection", () => {
    mockApi({});
    renderApp(<EditCollectionDialog collection={undefined} onOpenChange={() => undefined} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
