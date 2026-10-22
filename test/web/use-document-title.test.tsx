import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { initI18n } from "../../src/web/i18n.ts";
import { useDocumentTitle } from "../../src/web/use-document-title.ts";

initI18n();

function Titled(props: { title: string | undefined }) {
  useDocumentTitle(props.title);
  return null;
}

describe("useDocumentTitle", () => {
  it("names the tab after the open item and restores the app name on leave", () => {
    const view = render(<Titled title="提示词工程 [02-Raw]" />);
    expect(document.title).toBe("提示词工程 [02-Raw] - Amber");
    view.rerender(<Titled title={undefined} />);
    expect(document.title).toBe("Amber");
    view.rerender(<Titled title="另一讲" />);
    expect(document.title).toBe("另一讲 - Amber");
    view.unmount();
    expect(document.title).toBe("Amber");
  });
});
