/**
 * Copies plain text. The async Clipboard API needs a secure context, so a self-hosted
 * server reached over plain http has no `navigator.clipboard`; there the legacy
 * `execCommand("copy")` on a scratch textarea is the fallback. That fallback has to move
 * the document selection and focus onto the textarea, so both are put back afterwards:
 * copying must not drop what the user had selected. Resolves whether a copy happened.
 */
export async function copyText(text: string): Promise<boolean> {
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  if (clipboard !== undefined && typeof clipboard.writeText === "function") {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      // Denied or unavailable: try the legacy path below.
    }
  }
  if (legacyCopy(text)) return true;
  console.warn("copy to clipboard failed");
  return false;
}

function legacyCopy(text: string): boolean {
  if (typeof document === "undefined" || typeof document.execCommand !== "function") return false;
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const selection = document.getSelection();
  const ranges: Range[] = [];
  if (selection !== null) {
    for (let index = 0; index < selection.rangeCount; index += 1) ranges.push(selection.getRangeAt(index).cloneRange());
  }
  const scratch = document.createElement("textarea");
  scratch.value = text;
  scratch.setAttribute("readonly", "");
  scratch.setAttribute("aria-hidden", "true");
  scratch.style.position = "fixed";
  scratch.style.top = "0";
  scratch.style.left = "0";
  scratch.style.opacity = "0";
  scratch.style.pointerEvents = "none";
  document.body.append(scratch);
  let copied = false;
  try {
    scratch.focus({ preventScroll: true });
    scratch.select();
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  } finally {
    scratch.remove();
    // Focus first: focusing can move the selection, the saved ranges go back last.
    if (focused !== null && focused.isConnected) focused.focus({ preventScroll: true });
    if (selection !== null) {
      selection.removeAllRanges();
      for (const range of ranges) selection.addRange(range);
    }
  }
  return copied;
}
