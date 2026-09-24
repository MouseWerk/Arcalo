// „Als HTML-Datei teilen“: one self-contained HTML file (styles inline, images as data URIs,
// system fonts, no scripts, nothing loaded from elsewhere). The page content is rendered by
// `editor/shareHtml.ts`; this module assembles the document around it.

export const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Attachments up to this size are embedded as download links; larger ones are listed by name. */
export const EMBED_FILE_BYTES = 1024 * 1024;

export interface ExportSection {
  /** Anchor of the page (`page-12`). */
  id: string;
  title: string;
  /** Last change, already formatted („24.09.2026“). */
  date: string;
  /** Rendered body (from `renderPageHtml`). */
  body: string;
  /** Depth below the exported page (0 = the page itself), for the table of contents. */
  depth: number;
}

/** A file name for the page: reserved characters replaced, `.html` appended. */
export function htmlFileName(title: string): string {
  const base = title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").replace(/\s+/g, " ").trim().replace(/^\.+/, "").slice(0, 120);
  return `${base || "Seite"}.html`;
}

/** MIME type of an attachment by its extension (data URIs). */
export function mimeOf(name: string): string {
  const ext = (name.split(".").pop() ?? "").toLowerCase();
  const types: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    pdf: "application/pdf",
    txt: "text/plain",
    csv: "text/csv",
    json: "application/json",
    zip: "application/zip",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  };
  return types[ext] ?? "application/octet-stream";
}

/** `data:` URI of bytes. */
export function dataUri(bytes: Uint8Array, mime: string): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${mime};base64,${btoa(bin)}`;
}

/** The whole document: title, date, (for several pages) a table of contents, the pages, footer. */
export function buildHtmlDocument(sections: ExportSection[], opts: { created: string }): string {
  const [main, ...subs] = sections;
  const toc = subs.length
    ? `<nav class="doc-toc" aria-label="Inhalt"><h2>Inhalt</h2><ol>${sections
        .map((s) => `<li style="--depth:${s.depth}"><a href="#${s.id}">${escapeHtml(s.title)}</a></li>`)
        .join("")}</ol></nav>`
    : "";
  // The table of contents of several pages sits under the first page's title.
  const article = (s: ExportSection, first: boolean) =>
    `<article class="page" id="${s.id}">
<header class="page-head"><h1 class="page-title${first ? "" : " sub"}">${escapeHtml(s.title)}</h1>
<p class="page-date">Stand: ${escapeHtml(s.date)}</p></header>${first ? toc : ""}
<div class="prose">${s.body}</div>
</article>`;
  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Annalo">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; media-src data:">
<title>${escapeHtml(main?.title ?? "Seite")}</title>
<style>${EXPORT_CSS}</style>
</head>
<body>
<main>
${main ? article(main, true) : ""}
${subs.map((s) => article(s, false)).join("\n")}
</main>
<footer class="made-with">Erstellt mit Annalo am ${escapeHtml(opts.created)}</footer>
</body>
</html>
`;
}

// Reading typography of the app (light, print-friendly), a dark variant by prefers-color-scheme.
export const EXPORT_CSS = `
:root{color-scheme:light dark;--bg:#fff;--text:#18181b;--text-2:#52525b;--text-3:#6b6b74;--border:rgb(15 15 20/.09);--border-strong:rgb(15 15 20/.14);--raised:#f7f7f9;--accent:#4f46e5;--accent-soft:rgb(99 102 241/.1);--mark:rgb(250 204 21/.35);--info:#0284c7;--success:#157034;--warning:#a14a08;--danger:#dc2626;--violet:#7c3aed;--code:#f4f4f6}
@media (prefers-color-scheme:dark){:root{--bg:#16171a;--text:#ececef;--text-2:#a7a9b1;--text-3:#8b8e98;--border:rgb(255 255 255/.07);--border-strong:rgb(255 255 255/.12);--raised:#1c1d21;--accent:#a5b4fc;--accent-soft:rgb(129 140 248/.14);--mark:rgb(250 204 21/.22);--info:#38bdf8;--success:#4ade80;--warning:#fbbf24;--danger:#f87171;--violet:#a78bfa;--code:#0e0f11}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.72 "Segoe UI Variable Text","Segoe UI",system-ui,-apple-system,"Helvetica Neue",Arial,sans-serif;overflow-wrap:break-word}
main{max-width:800px;margin:0 auto;padding:48px 32px 32px}
.page+.page{margin-top:64px;padding-top:32px;border-top:1px solid var(--border-strong)}
.page-title{margin:0;font-size:34px;line-height:1.2;letter-spacing:-.025em;font-weight:700}
.page-title.sub{font-size:26px}
.page-date{margin:6px 0 28px;color:var(--text-3);font-size:13px}
.doc-toc{margin:0 0 32px;padding:14px 18px;border:1px solid var(--border);border-radius:8px;background:var(--raised)}
.doc-toc h2{margin:0 0 6px;font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:var(--text-3)}
.doc-toc ol{list-style:none;margin:0;padding:0}
.doc-toc li{padding-left:calc(var(--depth,0)*18px)}
.prose>*+*{margin-top:.55em}
.prose p{margin:0}
.prose h1,.prose h2,.prose h3,.prose h4,.prose h5,.prose h6{letter-spacing:-.015em;line-height:1.3;margin:1.5em 0 .3em;font-weight:650}
.prose h1{font-size:1.75em}.prose h2{font-size:1.4em}.prose h3{font-size:1.17em}.prose h4{font-size:1em;color:var(--text-2)}
.prose>:first-child{margin-top:0}
.prose strong{font-weight:650}
a{color:var(--accent);text-decoration:underline;text-decoration-color:color-mix(in srgb,var(--accent) 40%,transparent);text-underline-offset:3px}
.wikilink{color:var(--accent);text-decoration:none;background:linear-gradient(transparent 62%,var(--accent-soft) 62%)}
span.wikilink{color:var(--text-2);background:none}
code{font-family:"Cascadia Code",Consolas,ui-monospace,"SF Mono",Menlo,monospace;font-size:.86em;padding:.15em .35em;border-radius:4px;background:var(--code)}
pre{margin:.9em 0;padding:14px 16px;border-radius:8px;background:var(--code);border:1px solid var(--border);overflow-x:auto}
pre code{padding:0;background:none;font-size:.84em;line-height:1.65;white-space:pre}
blockquote{margin:.9em 0;padding:2px 0 2px 16px;border-left:3px solid var(--border-strong);color:var(--text-2)}
.prose ul,.prose ol{padding-left:1.5em;margin:.4em 0}
.prose li>p{margin:0}
.prose li::marker{color:var(--text-3)}
ul.tasks{list-style:none;padding-left:.2em}
ul.tasks li{display:flex;gap:10px;align-items:flex-start}
ul.tasks li>label{flex:none;margin-top:.2em}
ul.tasks li.done>div{color:var(--text-3);text-decoration:line-through}
hr{border:0;border-top:1px solid var(--border-strong);margin:1.8em 0}
mark{background:var(--mark);color:inherit;border-radius:3px;padding:0 2px}
table{border-collapse:collapse;margin:1em 0;font-size:.93em;display:block;max-width:100%;overflow-x:auto}
th,td{border:1px solid var(--border-strong);padding:6px 10px;text-align:left;vertical-align:top;min-width:6em}
th{background:var(--raised);font-weight:600}
img{max-width:100%;height:auto;border-radius:8px;border:1px solid var(--border);vertical-align:bottom}
img.drawing{background:#fff}
.missing{color:var(--text-3);font-style:italic}
.tag{color:var(--accent);background:var(--accent-soft);border-radius:4px;padding:0 3px}
.time-chip{display:inline-block;padding:0 8px;border-radius:999px;background:color-mix(in srgb,var(--success) 12%,transparent);color:var(--success);font-size:.85em;font-weight:600}
.attachment{display:inline-flex;align-items:center;gap:6px;padding:1px 8px;border:1px solid var(--border-strong);border-radius:6px;background:var(--raised);color:var(--text);font-size:.9em;text-decoration:none}
.attachment small{color:var(--text-3)}
.attachments{margin-top:2em;padding-top:10px;border-top:1px solid var(--border)}
.attachments h2,.footnotes h2{margin:0 0 6px;font-size:13px;font-weight:600;color:var(--text-3)}
.attachments ul{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:6px}
.callout{--c:var(--info);margin:.9em 0;padding:10px 14px;border-radius:8px;background:color-mix(in srgb,var(--c) 10%,transparent);box-shadow:inset 3px 0 0 var(--c)}
.callout-tip,.callout-success,.callout-check,.callout-done{--c:var(--success)}
.callout-warning,.callout-caution,.callout-attention,.callout-todo{--c:var(--warning)}
.callout-danger,.callout-error,.callout-bug,.callout-failure{--c:var(--danger)}
.callout-question,.callout-faq,.callout-example,.callout-abstract{--c:var(--violet)}
.callout-quote{--c:var(--text-3)}
.callout-title{font-weight:600}
.callout-label{font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--c);margin-right:8px}
.callout>*+*{margin-top:.55em}
details.callout>summary{cursor:pointer;list-style-position:outside;margin-left:1em}
details.callout[open]>summary{margin-bottom:.4em}
.columns{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(0,1fr);gap:28px;margin:1em 0}
.column>*+*{margin-top:.55em}
.column>:first-child{margin-top:0}
.toc{margin:1em 0;padding:10px 14px;border:1px solid var(--border);border-radius:8px;background:var(--raised);font-size:.9em}
.toc .toc-head{font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--text-3)}
.toc ul{list-style:none;margin:0;padding:0}
.toc ul ul{margin-left:6px;padding-left:12px;border-left:1px solid var(--border)}
.toc a{color:var(--text-2);text-decoration:none}
sup.fn-ref a{text-decoration:none;font-weight:600;font-size:.85em;padding:0 2px}
.footnotes{margin-top:2.2em;padding-top:12px;border-top:1px solid var(--border);font-size:.9em;color:var(--text-2)}
.footnotes ol{padding-left:1.6em;margin:0}
.footnotes a.back{text-decoration:none;margin-left:4px}
.hljs-comment,.hljs-quote{color:var(--text-3);font-style:italic}
.hljs-keyword,.hljs-selector-tag,.hljs-built_in{color:#9333ea}
.hljs-string,.hljs-attr,.hljs-template-tag{color:#15803d}
.hljs-number,.hljs-literal,.hljs-variable{color:#c2410c}
.hljs-title,.hljs-function,.hljs-section{color:#1d4ed8}
.hljs-type,.hljs-class{color:#a16207}
.hljs-meta,.hljs-symbol{color:#0e7490}
@media (prefers-color-scheme:dark){.hljs-keyword,.hljs-selector-tag,.hljs-built_in{color:#c084fc}.hljs-string,.hljs-attr,.hljs-template-tag{color:#4ade80}.hljs-number,.hljs-literal,.hljs-variable{color:#fb923c}.hljs-title,.hljs-function,.hljs-section{color:#60a5fa}.hljs-type,.hljs-class{color:#facc15}.hljs-meta,.hljs-symbol{color:#22d3ee}}
.made-with{max-width:800px;margin:0 auto;padding:24px 32px 40px;color:var(--text-3);font-size:11px}
@media (max-width:640px){main{padding:28px 18px}.page-title{font-size:26px}.columns{grid-auto-flow:row;gap:10px}}
@media print{:root{--bg:#fff;--text:#000;--text-2:#333;--text-3:#666;--raised:#f6f6f6;--code:#f4f4f4}main{max-width:none;padding:0}.page+.page{break-before:page;border:0;margin-top:0}pre,blockquote,.callout,table,img{break-inside:avoid}details.callout>*{display:block}a{color:inherit}}
`.trim();
