import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TerminologyEditor } from "../../../src/web/components/terminology-editor.tsx";
import { mockApi, renderApp } from "../../fixtures/web/render.tsx";

describe("TerminologyEditor", () => {
  it("replaces the whole scope with the edited table", async () => {
    const api = mockApi({
      "GET /api/terminology?scope=collection%3Ac1": {
        body: { scope: "collection:c1", entries: [{ id: "e1", ordinal: 0, term: "RAG", normalizedKey: "rag", rule: "keep_original" }] },
      },
      "PUT /api/terminology": (call) => ({
        body: {
          scope: "collection:c1",
          entries: (call.body as { entries: Array<{ term: string }> }).entries.map((entry, ordinal) => ({ ...entry, id: `e${ordinal}`, ordinal, normalizedKey: entry.term.toLowerCase() })),
        },
      }),
    });
    renderApp(<TerminologyEditor scope="collection:c1" />);
    expect(((await screen.findByDisplayValue("RAG")) as HTMLInputElement).value).toBe("RAG");
    fireEvent.click(screen.getByRole("button", { name: "添加术语" }));
    const terms = screen.getAllByLabelText("术语");
    fireEvent.change(terms[1] as HTMLElement, { target: { value: "向量数据库" } });
    fireEvent.change(screen.getAllByLabelText("译法（可选）")[1] as HTMLElement, { target: { value: "vector database" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(api.calls.some((call) => call.method === "PUT")).toBe(true));
    const put = api.calls.find((call) => call.method === "PUT");
    expect(put?.path).toBe("/api/terminology?scope=collection%3Ac1");
    expect(put?.body).toEqual({
      entries: [
        { term: "RAG", rule: "keep_original" },
        { term: "向量数据库", translation: "vector database" },
      ],
    });
  });
});
