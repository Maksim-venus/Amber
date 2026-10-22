import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router";
import { recognizeLinks } from "../links.ts";

/** Location state the new page reads to prefill its link box. */
export interface NewPagePrefill {
  prefill: string;
}

const EDITABLE_SELECTOR = ['[contenteditable=""]', '[contenteditable="true"]', '[role="textbox"]'].join(",");
const DIALOG_SELECTOR = ['[role="dialog"]', '[role="alertdialog"]'].join(",");

function isEditable(element: Element | null): boolean {
  if (element === null) {
    return false;
  }
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
    return true;
  }
  return element.closest(EDITABLE_SELECTOR) !== null;
}

/**
 * Decides whether a paste is an "open this link" gesture. All four guards
 * must hold, otherwise the paste stays an ordinary paste: focus is not in an editable
 * field, no dialog is open, the text holds a supported link, and the new page is not
 * already showing. Returns the links to prefill.
 */
export function pasteTarget(input: { text: string; activeElement: Element | null; dialogOpen: boolean; pathname: string }): string | undefined {
  if (isEditable(input.activeElement) || input.dialogOpen || input.pathname === "/new") {
    return undefined;
  }
  const links = recognizeLinks(input.text);
  return links.length === 0 ? undefined : links.map((link) => link.url).join("\n");
}

/** Document-level URL paste that jumps to the new page when all four guards pass. */
export function usePasteGuard(): void {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  useEffect(() => {
    const listener = (event: ClipboardEvent): void => {
      const prefill = pasteTarget({
        text: event.clipboardData?.getData("text/plain") ?? "",
        activeElement: document.activeElement,
        dialogOpen: document.querySelector(DIALOG_SELECTOR) !== null,
        pathname,
      });
      if (prefill === undefined) {
        return;
      }
      event.preventDefault();
      const state: NewPagePrefill = { prefill };
      void navigate("/new", { state });
    };
    document.addEventListener("paste", listener);
    return () => document.removeEventListener("paste", listener);
  }, [navigate, pathname]);
}
