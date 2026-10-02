// The live view of a ```mermaid block: the diagram (rendered when it scrolls into view, again on
// a theme switch and after edits), a bar with „Quelltext“/„Fertig“ and the SVG/PNG export, and on
// errors the message with the source. Plain DOM, like the other node views.

import { t } from "../lib/i18n";
import { DIAGRAM_THEME_EVENT, diagramTheme, exportDiagram, renderDiagram } from "./mermaid";
import { mermaidKind } from "./embedSyntax";
import { whenVisible } from "./lazyRender";
import type { RichControl, RichPreview } from "./richBlocks";

const ICON =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
const ICONS = {
  diagram: `${ICON}<rect x="16" y="16" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="9" y="2" width="6" height="6" rx="1"/><path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3"/><path d="M12 12V8"/></svg>`,
  code: `${ICON}<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/></svg>`,
  check: `${ICON}<path d="M20 6 9 17l-5-5"/></svg>`,
  download: `${ICON}<path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/></svg>`,
  alert: `${ICON}<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>`,
};

function button(cls: string, icon: string, label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `rich-btn ${cls}`;
  b.innerHTML = icon;
  b.append(document.createTextNode(` ${label}`));
  b.addEventListener("mousedown", (e) => e.preventDefault());
  b.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick();
  });
  return b;
}

/** Mounts a diagram into `dom`; `ctl` null for read-only places (embeds). */
export function mountDiagram(dom: HTMLElement, initial: string, ctl: RichControl | null, title: () => string): RichPreview {
  dom.classList.add("mmd");
  dom.dataset.state = "waiting";
  const view = document.createElement("div");
  view.className = "mmd-view";
  view.setAttribute("role", "img");
  const error = document.createElement("div");
  error.className = "rich-error";
  error.setAttribute("role", "alert");
  error.hidden = true;
  const foot = document.createElement("div");
  foot.className = "rich-foot";
  const kind = document.createElement("span");
  kind.className = "rich-kind";
  const spacer = document.createElement("span");
  spacer.className = "grow";
  foot.innerHTML = ICONS.diagram;
  let source = initial;
  let editing = false;
  const edit = ctl ? button("mmd-edit", ICONS.code, t("mmd.source"), () => (editing ? ctl.done() : ctl.edit())) : null;
  const svgBtn = button("mmd-export", ICONS.download, "SVG", () => void exportDiagram(source, "svg", title()));
  const pngBtn = button("mmd-export", ICONS.download, "PNG", () => void exportDiagram(source, "png", title()));
  svgBtn.title = t("mmd.exportSvg");
  pngBtn.title = t("mmd.exportPng");
  foot.append(kind, spacer, ...(edit ? [edit] : []), svgBtn, pngBtn);
  dom.append(view, error, foot);

  let alive = true;
  let seen = false;
  let rendered = "";
  let timer = 0;
  const render = async () => {
    seen = true;
    const src = source;
    const theme = diagramTheme();
    if (rendered === `${theme}\n${src}`) return;
    dom.dataset.state = dom.dataset.state === "waiting" ? "loading" : dom.dataset.state;
    const res = await renderDiagram(src, theme);
    if (!alive || src !== source) return;
    rendered = `${theme}\n${src}`;
    if ("svg" in res) {
      view.innerHTML = res.svg;
      view.setAttribute("aria-label", t("mmd.label", { kind: mermaidKind(src) ?? "" }));
      error.hidden = true;
      dom.dataset.state = "ready";
    } else {
      error.replaceChildren();
      const head = document.createElement("div");
      head.className = "rich-error-head";
      head.innerHTML = ICONS.alert;
      head.append(document.createTextNode(` ${src.trim() ? t("mmd.failed") : t("mmd.empty")}`));
      const msg = document.createElement("pre");
      msg.className = "rich-error-msg";
      msg.textContent = res.error;
      error.append(head);
      if (src.trim()) {
        const code = document.createElement("pre");
        code.className = "rich-error-src";
        code.textContent = src;
        error.append(msg, code);
      }
      error.hidden = false;
      view.replaceChildren();
      dom.dataset.state = "error";
    }
  };
  const cancel = whenVisible(dom, render);
  const onTheme = () => {
    if (seen) void render();
  };
  window.addEventListener(DIAGRAM_THEME_EVENT, onTheme);
  const sync = () => {
    kind.textContent = `Mermaid${mermaidKind(source) ? ` · ${mermaidKind(source)}` : ""}`;
    if (edit) {
      edit.lastChild!.textContent = ` ${editing ? t("rich.done") : t("mmd.source")}`;
      edit.querySelector("svg")!.outerHTML = editing ? ICONS.check : ICONS.code;
      edit.setAttribute("aria-pressed", String(editing));
    }
    dom.classList.toggle("is-editing", editing);
  };
  sync();
  return {
    update(next, isEditing) {
      editing = isEditing;
      const changed = next !== source;
      source = next;
      sync();
      if (!changed || !seen) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void render(), 350);
    },
    destroy() {
      alive = false;
      cancel();
      window.clearTimeout(timer);
      window.removeEventListener(DIAGRAM_THEME_EVENT, onTheme);
    },
  };
}
