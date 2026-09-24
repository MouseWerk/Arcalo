// Ctrl K: commands, pages, full-text search, "/zeit …" booking and "? question".
// Ctrl O: quick switcher (pages only).

import { useEffect, useMemo, useRef, useState } from "react";
import {
  FileCode2, MoveHorizontal, ArrowLeft, ArrowRight, CalendarDays, Columns2, Plus, Briefcase, CalendarCheck2, Download, FilePlus2, FolderInput, Hash, Moon, PanelLeft, PanelRight, RefreshCw, Search, Settings, Sparkles, Paperclip, Square, Timer, Trash2, Play, Focus, ListChecks, LayoutTemplate, Mail, ListPlus, PenTool, Presentation, Activity, CalendarSearch, Target, NotebookPen,
} from "lucide-react";
import { api } from "../lib/api";
import { useApp, savePref } from "../store/app";
import { openAssistant, openToday } from "./Ribbon";
import { openCalendar } from "./CalendarPopover";
import { PageIcon } from "./icons";
import { createSubpage } from "../views/PageView";
import { requestAddProperty } from "../views/PageProperties";
import { requestPageCommand } from "../lib/pageModes";
import { stopTimer } from "./Sidebar";
import { hoursFromMinutes, isoDay, isoWeek, weekStart } from "../lib/format";
import type { SearchHit } from "../lib/types";
import { importVault, exportVault, toggleTheme } from "../lib/actions";
import { newPageFromTemplate } from "./Templates";
import { insertDrawingInActiveNote } from "../editor/drawings";
import { snippetHtml } from "../lib/quicksearch";
import { keys } from "../lib/shortcut";
import { t, useT } from "../lib/i18n";
import { hint } from "../lib/keymap";
import { startPresentation } from "./Presentation";
import { abortFocus, openFocusDialog } from "./Focus";
import { openActivityDay } from "../views/ActivityView";
import { reloadEditors } from "../editor/NoteEditor";

interface Item {
  id: string;
  section: string;
  title: string;
  subtitle?: string;
  snippet?: string;
  icon: React.ReactNode;
  hint?: string;
  run: (newTab: boolean) => void;
}

/** Subsequence match score: prefers prefix and word-start matches. */
function fuzzy(text: string, q: string): number {
  if (!q) return 1;
  const t = text.toLowerCase();
  const i = t.indexOf(q);
  if (i === 0) return 100 - t.length / 100;
  if (i > 0) return (/[\s\-_/.]/.test(t[i - 1]) ? 80 : 60) - t.length / 100;
  let ti = 0;
  for (const c of q) {
    ti = t.indexOf(c, ti);
    if (ti < 0) return 0;
    ti++;
  }
  return 20 - t.length / 100;
}

const ic = (C: typeof Search) => <C size={16} strokeWidth={1.75} />;

export function CommandPalette() {
  useT();
  const open = useApp((s) => s.paletteOpen);
  const mode = useApp((s) => s.paletteMode);
  const initial = useApp((s) => s.paletteQuery);
  const pages = useApp((s) => s.pages);
  const timer = useApp((s) => s.timer);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const s = useApp.getState;

  useEffect(() => {
    if (open) {
      setQ(initial);
      setSel(0);
      setHits([]);
      setTimeout(() => input.current?.focus(), 10);
    }
  }, [open, initial]);

  const query = q.trim();
  useEffect(() => {
    if (!open || mode === "pages" || query.length < 2 || query.startsWith("/") || query.startsWith("?")) {
      setHits([]);
      return;
    }
    let alive = true;
    const t = setTimeout(() => api.search(query, 12).then((h) => alive && setHits(h)).catch(() => {}), 90);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [query, open, mode]);

  const close = () => s().set({ paletteOpen: false });

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    const lower = query.toLowerCase();

    if (mode === "all" && /^\/(zeit|time)\b/i.test(query)) {
      out.push({
        id: "zeit",
        section: "Zeiterfassung",
        title: `Buchen: ${query.replace(/^\/(zeit|time)\s*/i, "") || "…"}`,
        subtitle: "Netzplan/Vorgang Dauer #Leistungsart Beschreibung",
        icon: ic(Timer),
        hint: "Enter",
        run: async () => {
          try {
            const out2 = await api.logTime(query);
            s().toast({ tone: "success", title: `${hoursFromMinutes(out2.entry.duration_minutes)} h gebucht`, detail: out2.entry.description || undefined });
            s().alerts(out2.alerts);
            s().bumpEntries();
          } catch (e) {
            s().error("Buchung fehlgeschlagen", e);
          }
        },
      });
      return out;
    }
    if (mode === "all" && query.startsWith("?")) {
      const question = query.slice(1).trim();
      out.push({
        id: "ask",
        section: "Assistent",
        title: question ? `Fragen: ${question}` : "Frage an den Assistenten…",
        icon: ic(Sparkles),
        hint: "Enter",
        run: () => {
          if (!question) return;
          s().set({ panelOpen: true, panelTab: "assistant", pendingAsk: question });
        },
      });
      return out;
    }

    const pageItems = [...pages.values()]
      .map((p) => {
        const score = fuzzy(p.title, lower);
        return { p, score: score > 0 ? score + (p.favorite ? 5 : 0) : 0 };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || b.p.updated_at.localeCompare(a.p.updated_at))
      .slice(0, lower ? 8 : 6)
      .map(({ p }) => ({
        id: `page-${p.id}`,
        section: lower ? "Seiten" : "Zuletzt bearbeitet",
        title: p.title,
        subtitle: p.parent_id != null ? pages.get(p.parent_id)?.title : undefined,
        icon: <PageIcon name={p.icon} size={16} />,
        run: (newTab: boolean) => s().openPage(p.id, { newTab }),
      }));
    if (!lower) pageItems.sort((a, b) => (pages.get(+b.id.slice(5))!.updated_at).localeCompare(pages.get(+a.id.slice(5))!.updated_at));
    out.push(...pageItems);

    if (mode === "pages") {
      if (lower && !pageItems.some((p) => p.title.toLowerCase() === lower))
        out.push({ id: "create", section: "Neu", title: `„${query}“ anlegen`, icon: ic(FilePlus2), run: () => createSubpage(null, query) });
      return out;
    }

    const commands: Omit<Item, "section">[] = [
      { id: "new", title: t("cmd.newPage"), icon: ic(FilePlus2), hint: hint("new_page"), run: () => createSubpage(null) },
      { id: "from-template", title: t("cmd.fromTemplate"), icon: ic(LayoutTemplate), run: () => newPageFromTemplate() },
      {
        id: "today",
        title: t("cmd.dailyNote"),
        icon: ic(CalendarCheck2),
        hint: hint("daily_note"),
        run: () => openToday(),
      },
      { id: "calendar", title: t("cmd.calendar"), subtitle: t("cmd.calendarSub"), icon: ic(CalendarDays), hint: hint("calendar"), run: () => setTimeout(() => openCalendar(), 0) },
      ...(s().tabs.find((x) => x.id === s().activeTabId)?.kind === "page"
        ? [
            { id: "add-property", title: t("cmd.addProperty"), subtitle: t("cmd.addPropertySub"), icon: ic(ListPlus), hint: hint("add_property"), run: () => setTimeout(requestAddProperty, 0) },
            { id: "toggle-source", title: t("cmd.toggleSource"), icon: ic(FileCode2), hint: hint("toggle_source"), run: () => setTimeout(() => requestPageCommand("source"), 0) },
            { id: "full-width", title: t("cmd.fullWidth"), icon: ic(MoveHorizontal), hint: hint("full_width"), run: () => setTimeout(() => requestPageCommand("full"), 0) },
            { id: "drawing", title: t("cmd.insertDrawing"), subtitle: t("cmd.insertDrawingSub"), icon: ic(PenTool), run: () => setTimeout(insertDrawingInActiveNote, 0) },
            {
              id: "present",
              title: t("cmd.present"),
              subtitle: t("cmd.presentSub"),
              icon: ic(Presentation),
              hint: hint("present"),
              run: () => {
                const id = s().tabs.find((x) => x.id === s().activeTabId)?.pageId;
                if (id != null) void startPresentation(id);
              },
            },
          ]
        : []),
      { id: "newtab", title: t("cmd.newTab"), icon: ic(Plus), hint: hint("new_tab"), run: () => s().openTab({ kind: "home" }, { newTab: true }) },
      { id: "split", title: t("cmd.split"), icon: ic(Columns2), run: () => s().activeTabId && s().splitTab(s().activeTabId) },
      { id: "search", title: t("cmd.search"), icon: ic(Search), hint: hint("search"), run: () => { if (!s().sidebarOpen) { s().set({ sidebarOpen: true }); savePref("annalo.sidebar", true); } setTimeout(() => window.dispatchEvent(new Event("annalo:sidebar-search")), 30); } },
      { id: "back", title: t("cmd.back"), icon: ic(ArrowLeft), hint: hint("back"), run: () => s().goBack() },
      { id: "forward", title: t("cmd.forward"), icon: ic(ArrowRight), hint: hint("forward"), run: () => s().goForward() },
      timer
        ? { id: "timer", title: t("cmd.stopTimer"), icon: ic(Square), hint: hint("timer"), run: () => stopTimer() }
        : { id: "timer", title: t("cmd.startTimer"), icon: ic(Play), hint: hint("timer"), run: () => s().openTab({ kind: "timesheet" }) },
      { id: "timesheet", title: t("cmd.timesheet"), icon: ic(Timer), run: () => s().openTab({ kind: "timesheet" }) },
      { id: "tasks", title: t("cmd.tasks"), subtitle: t("cmd.tasksSub"), icon: ic(ListChecks), hint: hint("tasks"), run: () => s().openTab({ kind: "tasks" }) },
      { id: "projects", title: t("cmd.projects"), icon: ic(Briefcase), run: () => s().openTab({ kind: "projects" }) },
      { id: "activity", title: t("cmd.activity"), subtitle: t("cmd.activitySub"), icon: ic(Activity), run: () => s().openTab({ kind: "activity" }) },
      { id: "activity-day", title: t("cmd.activityDay"), icon: ic(CalendarSearch), run: () => setTimeout(() => s().set({ calendar: { onPick: openActivityDay } }), 0) },
      s().focus?.phase === "work"
        ? { id: "focus-session", title: t("cmd.focusAbort"), icon: ic(Square), run: () => void abortFocus() }
        : { id: "focus-session", title: t("cmd.focusStart"), subtitle: t("cmd.focusStartSub"), icon: ic(Target), run: () => openFocusDialog() },
      {
        id: "focus-note",
        title: t("cmd.focusNote"),
        icon: ic(NotebookPen),
        run: async () => {
          try {
            const id = await api.focusDailyLine();
            await s().refreshTree();
            reloadEditors([id]);
            s().toast({ tone: "success", title: "In die Tagesnotiz eingetragen", action: { label: "Öffnen", run: () => s().openPage(id) } });
          } catch (e) {
            s().error("Nicht eingetragen", e);
          }
        },
      },
      { id: "assistant", title: t("cmd.askAssistant"), icon: ic(Sparkles), hint: hint("assistant"), run: () => openAssistant() },
      { id: "weekly-report", title: t("cmd.weeklyReport"), subtitle: t("cmd.weeklyReportSub"), icon: ic(Mail), run: () => askWeeklyReport() },
      { id: "trash", title: t("cmd.trash"), icon: ic(Trash2), run: () => s().openTab({ kind: "trash" }) },
      { id: "attachments", title: t("cmd.attachments"), subtitle: t("cmd.attachmentsSub"), icon: ic(Paperclip), run: () => s().openTab({ kind: "attachments" }) },
      { id: "settings", title: t("cmd.settings"), icon: ic(Settings), hint: hint("settings"), run: () => s().openTab({ kind: "settings" }) },
      { id: "sidebar", title: t("cmd.toggleSidebar"), icon: ic(PanelLeft), hint: hint("toggle_sidebar"), run: () => { const v = !s().sidebarOpen; s().set({ sidebarOpen: v }); savePref("annalo.sidebar", v); } },
      { id: "panel", title: t("cmd.togglePanel"), icon: ic(PanelRight), hint: hint("toggle_panel"), run: () => { const v = !s().panelOpen; s().set({ panelOpen: v }); savePref("annalo.panel", v); } },
      { id: "focus", title: t("cmd.focusMode"), icon: ic(Focus), hint: hint("focus_mode"), run: () => s().set({ focusMode: !s().focusMode }) },
      { id: "theme", title: t("cmd.theme"), icon: ic(Moon), run: () => toggleTheme() },
      { id: "import", title: t("cmd.importVault"), icon: ic(FolderInput), run: () => importVault() },
      { id: "export", title: t("cmd.exportMd"), icon: ic(Download), run: () => exportVault() },
      {
        id: "index",
        title: t("cmd.reindex"),
        icon: ic(RefreshCw),
        run: async () => {
          try {
            const n = await api.indexPending();
            s().toast({ tone: "success", title: "Suchindex aktualisiert", detail: `${n} Abschnitte eingebettet` });
          } catch (e) {
            s().error("Index nicht aktualisiert", e);
          }
        },
      },
    ];
    out.push(
      ...commands
        .map((c) => ({ c, score: fuzzy(c.title, lower) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => (lower ? b.score - a.score : 0))
        .slice(0, lower ? 5 : 20)
        .map(({ c }) => ({ ...c, section: t("palette.commands") })),
    );

    for (const h of hits) {
      if (h.kind === "note")
        out.push({ id: `note-${h.page_id}`, section: "Inhalte", title: h.title, snippet: h.snippet, icon: <PageIcon name={h.icon} size={16} />, run: (nt) => s().openPage(h.page_id, { newTab: nt }) });
      else if (h.kind === "time_entry")
        out.push({ id: `te-${h.id}`, section: "Zeiteinträge", title: `${h.netzplan_nr}${h.vorgang_nr ? "/" + h.vorgang_nr : ""}`, snippet: h.snippet, icon: ic(Timer), run: () => s().openTab({ kind: "timesheet" }) });
    }
    if (lower && !pageItems.some((p) => p.title.toLowerCase() === lower))
      out.push({ id: "create", section: "Neu", title: `Seite „${query}“ anlegen`, icon: ic(FilePlus2), run: () => createSubpage(null, query) });
    const tagHits = lower.startsWith("#") ? lower.slice(1) : null;
    if (tagHits) out.unshift({ id: "tag", section: "Tags", title: `#${tagHits}`, icon: ic(Hash), run: () => s().openTab({ kind: "tag", tag: tagHits }) });
    return out;
  }, [query, pages, hits, mode, timer]);

  useEffect(() => setSel((v) => Math.min(v, Math.max(0, items.length - 1))), [items.length]);
  useEffect(() => {
    list.current?.querySelector(".pal-item.sel")?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  if (!open) return null;

  const run = (i: number, newTab = false) => {
    const it = items[i];
    if (!it) return;
    close();
    it.run(newTab);
  };

  let lastSection = "";
  return (
    <div className="overlay overlay-top" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label={t("cmd.palette")}>
        <div className="pal-input">
          <Search size={16} className="faint" />
          <input
            ref={input}
            value={q}
            placeholder={mode === "pages" ? t("palette.openPage") : t("palette.placeholder")}
            onChange={(e) => {
              setQ(e.target.value);
              setSel(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSel((v) => (v + 1) % Math.max(items.length, 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSel((v) => (v - 1 + items.length) % Math.max(items.length, 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                run(sel, e.ctrlKey || e.metaKey);
              } else if (e.key === "Escape") {
                e.preventDefault();
                close();
              }
            }}
            aria-label="Suche"
            spellCheck={false}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="pal-list" ref={list} role="listbox">
          {items.length === 0 && <div className="pal-empty">Keine Ergebnisse</div>}
          {/* Only „anlegen“ left: say so, instead of offering it as if it were a match. */}
          {query.trim() !== "" && items.length > 0 && items.every((it) => it.id === "create") && <div className="pal-nohits">Keine Treffer für „{query.trim()}“</div>}
          {items.map((it, i) => {
            const header = it.section !== lastSection ? it.section : null;
            lastSection = it.section;
            return (
              <div key={it.id + i}>
                {header && <div className="pal-section">{header}</div>}
                <div
                  role="option"
                  aria-selected={i === sel}
                  className={`pal-item ${i === sel ? "sel" : ""}`}
                  onMouseMove={() => sel !== i && setSel(i)}
                  onClick={(e) => run(i, e.ctrlKey || e.metaKey)}
                >
                  <span className="pal-icon">{it.icon}</span>
                  <span className="pal-text">
                    <span className="pal-title">
                      {it.title}
                      {it.subtitle && <span className="pal-sub">{it.subtitle}</span>}
                    </span>
                    {it.snippet && <span className="pal-snippet" dangerouslySetInnerHTML={{ __html: snippetHtml(it.snippet) }} />}
                  </span>
                  {it.hint ? <kbd>{it.hint}</kbd> : i === sel ? <ArrowRight size={14} className="faint" /> : null}
                </div>
              </div>
            );
          })}
        </div>
        <div className="pal-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> wählen</span>
          <span><kbd>Enter</kbd> öffnen</span>
          <span><kbd>{keys("Mod Enter")}</kbd> neuer Tab</span>
          <span className="grow" />
          <span className="faint">/zeit buchen · ? fragen · # Tag</span>
        </div>
      </div>
    </div>
  );
}

/** Opens the assistant with a request for this week's status e-mail (time_summary + list_tasks). */
export function askWeeklyReport(now = new Date()) {
  const from = isoDay(weekStart(now));
  const to = isoDay(now);
  const kw = isoWeek(now);
  const text = [
    `Erstelle eine Status-E-Mail auf Deutsch für KW ${kw} (${from} bis ${to}).`,
    `Hole die gebuchten Stunden mit dem Werkzeug time_summary (from "${from}", to "${to}") und die erledigten Aufgaben mit list_tasks (status "done", changed_since "${from}").`,
    "Gliederung: Betreff, kurze Zusammenfassung, Erledigt je Netzplan/Vorgang mit Stunden und Stichpunkten aus den Buchungstexten, erledigte Aufgaben, nächste Schritte, Summe der Stunden.",
    "Antworte nur mit der E-Mail in Markdown, ohne Vorbemerkung.",
  ].join("\n");
  useApp.getState().set({ panelOpen: true, panelTab: "assistant", pendingAsk: { text, display: `Wochenbericht KW ${kw}`, pageTitle: `Wochenbericht KW ${kw}`, tools: true } });
}
