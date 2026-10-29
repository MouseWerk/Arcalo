import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { Slice } from "@tiptap/pm/model";
import { buildExtensions, toMarkdown } from "./schema";
import { dataUrlFile, imageCopyFormats, inlinedImage, storedImageName } from "./imageClipboard";

// As `attachmentUrl`: the file name of a path.
const resolve = (n: string) => `arcalo-asset://localhost/${encodeURIComponent(n.split("/").pop()!)}`;
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGM4YWMDRAwQCgAlPgUBdJmUYAAAAABJRU5ErkJggg==";
const PNG = Uint8Array.from(atob(PNG_B64), (c) => c.charCodeAt(0));

function setup(md: string, uploaded: File[] = [], read: (name: string) => Promise<Uint8Array> = async () => PNG) {
  const el = document.createElement("div");
  document.body.append(el);
  let n = 0;
  const editor = new Editor({
    element: el,
    extensions: buildExtensions({
      attachmentUrl: resolve,
      uploadImage: async (f) => (uploaded.push(f), `neu${++n}.${f.name.split(".").pop()}`),
      readAttachment: read,
      copyFormats: async () => {},
    }),
    content: md,
    contentType: "markdown",
  });
  return editor;
}

/** Runs the editor's paste handlers like ProseMirror does for a paste event. */
function paste(editor: Editor, html: string, text = "", files: File[] = []) {
  const event = { clipboardData: { getData: (t: string) => (t === "text/plain" ? text : t === "text/html" ? html : ""), files }, preventDefault() {} } as unknown as ClipboardEvent;
  return editor.view.someProp("handlePaste", (f) => f(editor.view, event, Slice.empty)) ?? false;
}

const blobText = async (b: Blob | Promise<Blob>) => (await b).text();
const until = async (check: () => boolean) => {
  for (let i = 0; i < 50 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
};

describe("copying images", () => {
  it("a selected image: the note's HTML with the bytes inlined, its embed as text and the image as PNG", async () => {
    const editor = setup("Vorher ![[a1b2.png|480]] nachher\n");
    let pos = -1;
    editor.state.doc.descendants((n, p) => (n.type.name === "imageEmbed" ? ((pos = p), false) : true));
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)));
    const formats = imageCopyFormats(editor.view, editor.state.selection.content(), { resolve, read: async () => PNG })!;
    expect(Object.keys(formats).sort()).toEqual(["image/png", "text/html", "text/plain"]);
    const html = await blobText(formats["text/html"]);
    expect(html).toContain('data-embed="a1b2.png"');
    expect(html).toContain('data-alt="480"');
    expect(html).toContain("data-pm-slice");
    expect(html).toContain(`src="data:image/png;base64,${PNG_B64}"`);
    expect(await blobText(formats["text/plain"])).toBe("![[a1b2.png|480]]");
    expect(new Uint8Array(await (await formats["image/png"]).arrayBuffer())).toEqual(PNG);
    // Pasted in another note: the same stored file with its size (not the file name as caption).
    const other = setup("\n");
    other.view.pasteHTML(html);
    expect(toMarkdown(other)).toBe("![[a1b2.png|480]]\n");
    editor.destroy();
    other.destroy();
  });

  it("copied and pasted in a note, embeds and drawings keep their name, caption and size", () => {
    for (const md of ["![[a1b2.png]]", "![Plan](attachments/c3d4.png)", "![](https://example.org/x.png)", "![[a1b2.png|300x200]]", "![[a1b2.png|Skizze vom Whiteboard]]", "![[Plan.excalidraw]]", "![[Plan.excalidraw|400]]"]) {
      const editor = setup(`${md}\n`);
      editor.commands.selectAll();
      const { dom } = editor.view.serializeForClipboard(editor.state.selection.content());
      const other = setup("\n");
      other.view.pasteHTML(dom.innerHTML);
      expect(toMarkdown(other)).toBe(`${md}\n`);
      editor.destroy();
      other.destroy();
    }
  });

  it("text with images: the HTML carries the bytes of the selected images, read when they were selected", async () => {
    const reads: string[] = [];
    const editor = setup("Vorher ![[e5f6.png]] und ![](attachments/a7b8.png) nachher\n\nNur Text\n", [], async (n) => (reads.push(n), PNG));
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 1, editor.state.doc.child(0).nodeSize - 1)));
    // Not a single image: no formats beside ProseMirror's own copy.
    expect(imageCopyFormats(editor.view, editor.state.selection.content(), { resolve, read: async () => PNG })).toBeNull();
    await until(() => !!inlinedImage("e5f6.png") && !!inlinedImage("a7b8.png"));
    expect(reads.sort()).toEqual(["a7b8.png", "e5f6.png"]);
    const { dom, text } = editor.view.serializeForClipboard(editor.state.selection.content());
    expect(dom.innerHTML.match(/src="data:image\/png;base64,/g)).toHaveLength(2);
    expect(text).toBe("Vorher ![[e5f6.png]] und ![](attachments/a7b8.png) nachher");
    // Pasted in a note: the same files, the Markdown image with its path.
    const other = setup("\n");
    // No handler takes it (no file stored again), ProseMirror pastes the HTML.
    expect(paste(other, dom.innerHTML, text)).toBe(false);
    other.view.pasteHTML(dom.innerHTML);
    expect(toMarkdown(other)).toBe("Vorher ![[e5f6.png]] und ![](attachments/a7b8.png) nachher\n");
    // A selection of plain text reads nothing.
    const second = editor.state.doc.child(0).nodeSize;
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, second + 1, second + 5)));
    expect(reads).toHaveLength(2);
    editor.destroy();
    other.destroy();
  });

  it("knows the stored image of an <img> by its embed or its address, not web images", () => {
    const img = (attrs: Record<string, string>) => Object.assign(document.createElement("img"), {}) && Object.entries(attrs).reduce((el, [k, v]) => (el.setAttribute(k, v), el), document.createElement("img"));
    expect(storedImageName(img({ "data-embed": "x.png" }), resolve)).toBe("x.png");
    expect(storedImageName(img({ src: resolve("Bild 1.png") }), resolve)).toBe("Bild 1.png");
    expect(storedImageName(img({ src: "https://example.org/x.png" }), resolve)).toBeNull();
  });
});

describe("pasting images", () => {
  it("a copy in a note pastes the same stored image (with its size), not a new file from the PNG beside it", () => {
    const uploaded: File[] = [];
    const editor = setup("Ziel\n", uploaded);
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    const html = '<p data-pm-slice="1 1 []"><img data-embed="a1b2.png" data-alt="480" src="data:image/png;base64,AA=="></p>';
    const handled = paste(editor, html, "![[a1b2.png|480]]", [new File([PNG], "image.png", { type: "image/png" })]);
    // ProseMirror pastes the HTML itself.
    expect(handled).toBe(false);
    expect(uploaded).toEqual([]);
    editor.view.pasteHTML(html);
    expect(toMarkdown(editor)).toBe("Ziel![[a1b2.png|480]]\n");
    editor.destroy();
  });

  it("HTML with data: images (a web page, a mail): the images are stored and embedded", async () => {
    const uploaded: File[] = [];
    const editor = setup("\n", uploaded);
    const handled = paste(editor, `<p>Logo: <img src="data:image/png;base64,${PNG_B64}" alt="Logo"> und <img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E"></p>`, "Logo: und");
    expect(handled).toBe(true);
    await until(() => /neu2/.test(toMarkdown(editor)));
    // The alt text of a web image is no caption (it would be the size's place in `![[x.png|…]]`).
    expect(toMarkdown(editor)).toBe("Logo: ![[neu1.png]] und ![[neu2.svg]]\n");
    expect(uploaded.map((f) => [f.name, f.type, f.size])).toEqual([
      ["bild.png", "image/png", PNG.length],
      ["bild.svg", "image/svg+xml", 41],
    ]);
    editor.destroy();
  });

  it("Excel's table with its picture beside it becomes a table, not an image", () => {
    const uploaded: File[] = [];
    const editor = setup("\n", uploaded);
    paste(editor, "<table><tr><td>A</td><td>B</td></tr><tr><td>1</td><td>2</td></tr></table>", "A\tB\n1\t2\n", [new File([PNG], "image.png", { type: "image/png" })]);
    expect(uploaded).toEqual([]);
    expect(toMarkdown(editor)).toBe("| A   | B   |\n| --- | --- |\n| 1   | 2   |\n");
    editor.destroy();
  });

  it("reads data: addresses of images only", () => {
    expect(dataUrlFile(`data:image/jpeg;base64,${PNG_B64}`)?.name).toBe("bild.jpg");
    expect(dataUrlFile("data:text/html,<b>x</b>")).toBeNull();
    expect(dataUrlFile("data:image/png;base64,!!!")).toBeNull();
    expect(dataUrlFile(null)).toBeNull();
  });
});
