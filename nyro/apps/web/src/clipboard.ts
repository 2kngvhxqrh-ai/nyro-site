/**
 * Copying text, in the places NYRO actually runs.
 *
 * `navigator.clipboard` exists only in a secure context. NYRO is a single
 * process serving plain HTTP on :8787, so it is there at `localhost` and
 * simply UNDEFINED the moment you open the same server from another machine —
 * `http://192.168.1.50:8787`, the laptop on the sofa. `writeText` also rejects
 * when the document is not focused. Both failures were caught and ignored, so
 * every copy button in the app did nothing at all, silently, and looked
 * exactly like a button that had worked.
 *
 * The fallback is `document.execCommand("copy")`, which is deprecated and is
 * also the only thing that copies outside a secure context. It needs a real
 * selection in the document, so the text goes through an off-screen textarea —
 * `display: none` cannot be selected.
 *
 * Returns whether the text was copied, so the caller can say so rather than
 * claim a success it did not have.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Denied, or the document is not focused. The fallback below still works
    // in both cases, so this is not the end of the attempt.
  }
  return copyBySelection(text);
}

function copyBySelection(text: string): boolean {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.top = "0";
  area.style.left = "-9999px";
  document.body.appendChild(area);
  try {
    area.select();
    area.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
  }
}
