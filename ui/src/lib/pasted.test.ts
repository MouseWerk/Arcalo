import { describe, expect, it } from "vitest";
import { htmlIsContent, filesToStore } from "./pasted";

const png = () => new File([new Uint8Array([137, 80, 78, 71])], "image.png", { type: "image/png" });
const clip = (html: string, files: File[] = [png()]) => ({ files, getData: (t: string) => (t === "text/html" ? html : "") }) as unknown as DataTransfer;

describe("which pasted format counts", () => {
  it("a copy in a note: its HTML names the stored images, the image beside it is not stored again", () => {
    expect(filesToStore(clip('<p data-pm-slice="1 1 []"><img data-embed="a1b2.png" src="data:image/png;base64,AA=="></p>'))).toEqual([]);
    expect(filesToStore(clip('<img data-embed="a1b2.png" src="data:image/png;base64,AA==">'))).toEqual([]);
  });

  it("Word, Excel and Outlook: the text, not their picture of it", () => {
    expect(filesToStore(clip("<html><body><!--StartFragment--><p class=MsoNormal>Angebot <b>Q4</b></p><!--EndFragment--></body></html>"))).toEqual([]);
    expect(filesToStore(clip("<table><tr><td></td><td></td></tr></table>"))).toEqual([]);
  });

  it("a browser's „Bild kopieren“, a screenshot or files: the files", () => {
    const f = png();
    expect(filesToStore(clip('<meta charset="utf-8"><img src="https://example.org/logo.png" alt="Logo">', [f]))).toEqual([f]);
    expect(filesToStore(clip("<html><body><!--StartFragment--><img src='x.png'><!--EndFragment--></body></html>", [f]))).toEqual([f]);
    expect(filesToStore(clip("", [f]))).toEqual([f]);
    expect(filesToStore(clip("<p>Text</p>", []))).toEqual([]);
    expect(filesToStore(null)).toEqual([]);
  });

  it("HTML is the content when it has text, a table or a note's images", () => {
    expect(htmlIsContent("")).toBe(false);
    expect(htmlIsContent("<img src='a.png'>")).toBe(false);
    expect(htmlIsContent("<p> </p>")).toBe(false);
    expect(htmlIsContent("<p>a</p>")).toBe(true);
  });
});
