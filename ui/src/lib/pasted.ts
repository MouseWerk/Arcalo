// Which of a paste's (or a drop's) formats counts. A clipboard can hold the same content several
// times: HTML that names stored images (copied in a note) or holds text (Word, Excel, Outlook: their
// image is a picture of the selection) is the content; files count when there is no such HTML (a
// screenshot, „Bild kopieren“ in a browser, files from the file manager).

/** HTML that is the content itself: copied in a note (ProseMirror's slice, stored images by name) or with text or a table. */
export function htmlIsContent(html: string): boolean {
  if (!html) return false;
  if (/data-pm-slice|data-embed=/.test(html)) return true;
  const doc = new DOMParser().parseFromString(html, "text/html");
  return !!doc.body.querySelector("table") || (doc.body.textContent ?? "").trim() !== "";
}

/** The pasted or dropped files to store: none when the HTML beside them is the content (see `htmlIsContent`). */
export function filesToStore(data: DataTransfer | null | undefined): File[] {
  const files = [...(data?.files ?? [])];
  if (!files.length) return [];
  return htmlIsContent(data?.getData("text/html") ?? "") ? [] : files;
}
