// The live view of a page embed: a subtle frame with the source's title (a link), a collapse
// chevron and the embedded part, read-only, rendered like the page (renderPageHtml, `live`).
// It loads when scrolled into view, follows edits of the source page, nests up to
// MAX_EMBED_DEPTH, stops at cycles, and shows a calm notice with „Seite anlegen“ when the page or
// section is missing. Diagrams and queries inside render live too (`mountRich`).

import DOMPurify from "dompurify";
import { api, attachmentUrl, on } from "../lib/api";
import { useApp } from "../store/app";
import { t } from "../lib/i18n";
import type { EmbedView } from "../lib/types";
import { embedLabel, embedProblem, type EmbedRef, type RichKind } from "./embedSyntax";
import { renderPageHtml, type AttachmentSource } from "./shareHtml";
import { track, whenVisible, PRINT_PREPARE_EVENT } from "./lazyRender";
import { mountDiagram } from "./diagramView";
import type { RichControl, RichPreview } from "./richBlocks";

export interface EmbedHost {
  /** Lower-cased titles of the open page and the embeds around this one. */
  stack: string[];
  /** This embed's level (1 in the page itself). */
  depth: number;
  /** Opens a page by title (creates it when missing, like a link). */
  onOpen: (target: string, newTab: boolean) => void;
}

const ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
const CHEVRON = `${ICON}<path d="m6 9 6 6 6-6"/></svg>`;
const OPEN = `${ICON}<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>`;
const EMBED = `${ICON}<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="M8 13h8"/><path d="M8 17h5"/></svg>`;

const NO_FILES: AttachmentSource = { read: async () => null, size: async () => null };

/** Collapsed embeds, by the open page and the embed (kept while the app runs). */
const collapsed = new Set<string>();
let seq = 0;

/** Mounts a live preview of a rich code block (diagram or query) into `dom`. */
export function mountRich(kind: RichKind, dom: HTMLElement, source: string, ctl: RichControl | null, title: () => string): RichPreview {
  if (kind === "mermaid") return mountDiagram(dom, source, ctl, title);
  // Queries load their module when they come into view.
  type Handle = { update: (p: { source?: string; editing?: boolean }) => void; destroy: () => void };
  let handle: Handle | null = null;
  let alive = true;
  let state = { source, editing: false };
  dom.classList.add("rich-query");
  const cancel = whenVisible(dom, () =>
    track(
      import("./QueryBlock").then((m) => {
        if (!alive) return;
        handle = m.mountQuery(dom, { source: state.source, editing: state.editing, onEdit: ctl ? () => (state.editing ? ctl.done() : ctl.edit()) : null });
      }),
    ),
  );
  return {
    update(next, editing) {
      state = { source: next, editing };
      handle?.update(state);
    },
    destroy() {
      alive = false;
      cancel();
      handle?.destroy();
    },
  };
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/** A paragraph that holds only `node` (and blanks) is replaced as a whole. */
function blockOf(node: HTMLElement): HTMLElement {
  const p = node.parentElement;
  if (p?.tagName === "P" && [...p.childNodes].every((n) => n === node || (n.nodeType === 3 && !n.textContent?.trim()))) return p;
  return node;
}

/** Makes rendered page HTML interactive: nested embeds, diagrams, queries, links. Returns cleanup. */
export function hydrate(body: HTMLElement, host: EmbedHost, title: string): () => void {
  const cleanups: (() => void)[] = [];
  for (const span of body.querySelectorAll<HTMLElement>("span[data-page-embed]")) {
    const ref: EmbedRef = { target: span.dataset.pageEmbed ?? "", anchor: span.dataset.anchor ?? null, alt: span.dataset.alt ?? null };
    const frame = el("div", "page-embed");
    blockOf(span).replaceWith(frame);
    cleanups.push(mountPageEmbed(frame, ref, { ...host, stack: [...host.stack, title.toLowerCase()], depth: host.depth + 1 }));
  }
  for (const code of body.querySelectorAll<HTMLElement>("pre > code")) {
    const lang = /language-([\w-]+)/.exec(code.className)?.[1]?.toLowerCase();
    const kind: RichKind | null = lang === "mermaid" ? "mermaid" : lang === "query" || lang === "abfrage" ? "query" : null;
    if (!kind) continue;
    const box = el("div", `rich-preview rich-${kind}`);
    code.parentElement!.replaceWith(box);
    const p = mountRich(kind, box, code.textContent ?? "", null, () => title);
    cleanups.push(() => p.destroy());
  }
  for (const a of body.querySelectorAll<HTMLElement>("a[data-wikilink]")) {
    a.removeAttribute("href");
    a.tabIndex = 0;
    a.addEventListener("mousedown", (e) => {
      if (e.button !== 0 && e.button !== 1) return;
      e.preventDefault();
      host.onOpen(a.dataset.target ?? "", e.ctrlKey || e.metaKey || e.button === 1);
    });
  }
  for (const box of body.querySelectorAll<HTMLInputElement>("input[type=checkbox]")) box.disabled = true;
  return () => cleanups.forEach((c) => c());
}

/** Shows `![[target#anchor]]` in `dom`; returns its cleanup. */
export function mountPageEmbed(dom: HTMLElement, ref: EmbedRef, host: EmbedHost): () => void {
  const id = `pe${++seq}`;
  const memo = `${host.stack[0] ?? ""}>${ref.target.toLowerCase()}#${ref.anchor ?? ""}`;
  dom.classList.add("page-embed");
  dom.dataset.state = "waiting";
  dom.dataset.depth = String(host.depth);
  const head = el("div", "pe-head");
  const toggle = el("button", "pe-toggle");
  toggle.type = "button";
  toggle.innerHTML = CHEVRON;
  const icon = el("span", "pe-icon");
  icon.innerHTML = EMBED;
  const link = el("a", "pe-title", ref.alt || embedLabel(ref));
  link.tabIndex = 0;
  const open = el("button", "pe-open");
  open.type = "button";
  open.innerHTML = OPEN;
  open.title = t("embed.open");
  open.setAttribute("aria-label", t("embed.open"));
  head.append(toggle, icon, link, el("span", "grow"), open);
  const body = el("div", "pe-body");
  body.id = `${id}-body`;
  toggle.setAttribute("aria-controls", body.id);
  dom.replaceChildren(head, body);

  const setCollapsed = (c: boolean) => {
    dom.classList.toggle("is-collapsed", c);
    toggle.setAttribute("aria-expanded", String(!c));
    const label = c ? t("embed.expand") : t("embed.collapse");
    toggle.title = label;
    toggle.setAttribute("aria-label", label);
    if (c) collapsed.add(memo);
    else collapsed.delete(memo);
  };
  setCollapsed(collapsed.has(memo));
  toggle.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    setCollapsed(!dom.classList.contains("is-collapsed"));
  });
  const go = (e: MouseEvent) => {
    if (e.button !== 0 && e.button !== 1) return;
    e.preventDefault();
    e.stopPropagation();
    host.onOpen(view?.title ?? ref.target, e.ctrlKey || e.metaKey || e.button === 1);
  };
  link.addEventListener("mousedown", go);
  open.addEventListener("mousedown", go);
  for (const b of [toggle, open]) b.addEventListener("mousedown", (e) => e.button === 0 && e.preventDefault());

  let alive = true;
  let seen = false;
  let view: EmbedView | null = null;
  let shown = "";
  let cleanupBody: () => void = () => {};
  let timer = 0;

  const notice = (text: string, action?: { label: string; run: () => void }) => {
    cleanupBody();
    cleanupBody = () => {};
    shown = "";
    const box = el("div", "pe-notice");
    box.append(el("span", "", text));
    if (action) {
      const b = el("button", "btn btn-sm btn-secondary pe-create", action.label);
      b.type = "button";
      b.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        action.run();
      });
      box.append(b);
    }
    body.replaceChildren(box);
  };

  const load = async () => {
    seen = true;
    const problem = embedProblem(host.stack, host.depth, ref.target);
    if (problem) {
      dom.dataset.state = problem;
      notice(problem === "cycle" ? t("embed.cycle", { title: ref.target }) : t("embed.tooDeep"));
      return;
    }
    if (dom.dataset.state === "waiting") {
      dom.dataset.state = "loading";
      body.replaceChildren(el("div", "pe-loading faint", t("embed.loading")));
    }
    let v: EmbedView;
    try {
      v = await api.pageEmbed(ref.target, ref.anchor);
    } catch (e) {
      if (!alive) return;
      dom.dataset.state = "error";
      notice(`${t("embed.failed")}: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (!alive) return;
    view = v;
    if (!ref.alt) link.textContent = embedLabel({ target: v.title, anchor: ref.anchor });
    if (v.page_id == null) {
      dom.dataset.state = "missing";
      notice(t("embed.noPage", { title: ref.target }), {
        label: t("embed.create"),
        run: () =>
          void api
            .resolvePage(ref.target, true)
            .then(() => useApp.getState().refreshTree())
            .then(load, (e) => useApp.getState().error(t("embed.failed"), e)),
      });
      return;
    }
    if (v.content == null) {
      dom.dataset.state = "missing";
      notice(t("embed.noSection", { anchor: ref.anchor ?? "", title: v.title }));
      return;
    }
    // A cycle through the page's real title (`![[übersicht]]` for „Übersicht“).
    if (host.stack.includes(v.title.toLowerCase())) {
      dom.dataset.state = "cycle";
      notice(t("embed.cycle", { title: v.title }));
      return;
    }
    if (v.content === shown && dom.dataset.state === "ready") return;
    const html = await renderPageHtml(v.content, { id, files: NO_FILES, anchors: new Map(), live: { imageUrl: attachmentUrl } });
    if (!alive) return;
    cleanupBody();
    const content = el("div", "pe-content prose");
    content.innerHTML = DOMPurify.sanitize(html);
    if (!v.content.trim()) content.append(el("p", "faint", t("embed.empty")));
    body.replaceChildren(content);
    cleanupBody = hydrate(content, host, v.title);
    shown = v.content;
    dom.dataset.state = "ready";
  };
  const reload = (ms = 250) => {
    if (!seen || !alive) return;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void track(load()), ms);
  };
  const cancel = whenVisible(dom, () => track(load()));

  // Live: the source page saved here or elsewhere, pages created, renamed or synced.
  const onSaved = (e: Event) => {
    const d = (e as CustomEvent<{ id?: number }>).detail;
    if (view?.page_id != null && d?.id === view.page_id) reload();
  };
  window.addEventListener("annalo:page-saved", onSaved);
  const unlisten = [on("data://pages", () => reload(400)), on("gitsync://pulled", () => reload(400))];
  const unsub = useApp.subscribe((s, prev) => {
    if (s.pages !== prev.pages && dom.dataset.state === "missing") reload(100);
  });
  // Printing shows the embedded content, also of collapsed embeds.
  const onPrint = () => {
    if (!seen) void track(load());
  };
  window.addEventListener(PRINT_PREPARE_EVENT, onPrint);

  return () => {
    alive = false;
    cancel();
    window.clearTimeout(timer);
    cleanupBody();
    window.removeEventListener("annalo:page-saved", onSaved);
    window.removeEventListener(PRINT_PREPARE_EVENT, onPrint);
    unlisten.forEach((u) => u.then((f) => f()));
    unsub();
  };
}
