// The quick-search window (label "search", `#search`; global shortcut or tray „Suchen…“):
// full-text search over pages and time entries plus quick actions. Results open in the main
// window (`search_open` → `search://open`).

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, CalendarCheck2, FilePlus2, Play, Search, Square, Timer } from "lucide-react";
import { api, errorText, on } from "../lib/api";
import { applyTheme } from "../lib/actions";
import { hoursFromMinutes } from "../lib/format";
import { isZeit, keepQuery, quickItems, snippetHtml, type QsAction, type QsItem } from "../lib/quicksearch";
import type { Page, SearchHit } from "../lib/types";
import { PageIcon } from "./icons";
import { keys } from "../lib/shortcut";

const ic = (C: typeof Search) => <C size={16} strokeWidth={1.75} />;
const ACTION_ICONS: Partial<Record<QsAction["type"], React.ReactNode>> = {
  new_page: ic(FilePlus2),
  daily: ic(CalendarCheck2),
  timer_start: ic(Play),
  timer_stop: ic(Square),
  zeit: ic(Timer),
  timesheet: ic(Timer),
};

/** `NP-8801/1020` of the most recent finished booking of the last 60 days. */
async function lastReference(): Promise<string | null> {
  const from = new Date(Date.now() - 60 * 86400_000).toISOString();
  const rows = await api.entries(from);
  const last = rows.filter((r) => r.status_flag !== "running").sort((a, b) => b.start_time.localeCompare(a.start_time))[0];
  return last ? `${last.netzplan_nr}${last.vorgang_nr ? "/" + last.vorgang_nr : ""}` : null;
}

export function SearchApp() {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [recent, setRecent] = useState<Page[]>([]);
  const [timerRunning, setTimerRunning] = useState(false);
  const [lastRef, setLastRef] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  // When the window last lost focus (hidden); the query survives a quick return.
  const hiddenAt = useRef<number | null>(null);

  useEffect(() => {
    document.body.classList.add("search-mode");
    api
      .settings()
      .then((v) => applyTheme(v.settings.theme, v.settings.appearance))
      .catch(() => {});
    const refresh = () => {
      api.recentPages(6).then(setRecent, () => {});
      api.timerStatus().then((t) => setTimerRunning(!!t), () => {});
      lastReference().then(setLastRef, () => {});
    };
    const focus = () => {
      input.current?.focus();
      input.current?.select();
    };
    const shown = () => {
      if (!keepQuery(hiddenAt.current, Date.now())) setQ("");
      hiddenAt.current = null;
      setSel(0);
      setNotice(null);
      refresh();
      requestAnimationFrame(focus);
    };
    refresh();
    focus();
    const unlisten = on("search://shown", shown);
    const onBlur = () => (hiddenAt.current = Date.now());
    const onFocus = () => {
      if (hiddenAt.current != null) shown();
    };
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    document.body.classList.add("ready");
    return () => {
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
      unlisten.then((f) => f());
    };
  }, []);

  const query = q.trim();
  // Enter while results for the typed query are still on their way waits for them, so a
  // quick "name + Enter" opens the page instead of creating a new one.
  const [searching, setSearching] = useState(false);
  const [enterQueued, setEnterQueued] = useState<{ newTab: boolean } | null>(null);
  useEffect(() => {
    if (query.length < 2 || isZeit(query)) {
      setHits([]);
      setSearching(false);
      return;
    }
    let alive = true;
    setSearching(true);
    const done = (h: SearchHit[]) => {
      if (!alive) return;
      setHits(h);
      setSearching(false);
    };
    const t = setTimeout(() => api.search(query, 16).then(done, () => done([])), 80);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [query]);

  const items = useMemo(() => quickItems(query, { hits, recent, timerRunning, lastRef }), [query, hits, recent, timerRunning, lastRef]);
  useEffect(() => setSel((v) => Math.min(v, Math.max(0, items.length - 1))), [items.length]);
  useEffect(() => {
    list.current?.querySelector(".pal-item.sel")?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const hide = () => {
    hiddenAt.current = Date.now();
    api.searchHide().catch(() => {});
  };
  const openPage = (pageId: number, newTab: boolean) => api.searchOpen({ kind: "page", page_id: pageId, new_tab: newTab });

  const run = async (it: QsItem | undefined, newTab = false) => {
    if (!it || busy) return;
    const a = it.action;
    setBusy(true);
    setNotice(null);
    try {
      switch (a.type) {
        case "page":
          await openPage(a.pageId, newTab);
          break;
        case "new_page":
          await openPage((await api.createPage(a.title)).id, newTab);
          break;
        case "daily":
          await openPage((await api.dailyNote()).id, newTab);
          break;
        case "timer_stop":
          await api.searchOpen({ kind: "timer_stop" });
          break;
        case "timesheet":
          await api.searchOpen({ kind: "timesheet" });
          break;
        case "timer_start":
          await api.timerResumeLast();
          setTimerRunning(true);
          hide();
          break;
        case "zeit": {
          const out = await api.captureSubmit(a.line);
          const b = out.bookings[0];
          setQ("");
          setNotice({ error: false, text: b ? `${hoursFromMinutes(b.entry.duration_minutes)} h auf ${b.reference} gebucht` : "Gebucht" });
          break;
        }
      }
      hiddenAt.current = Date.now();
    } catch (e) {
      setNotice({ error: true, text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!enterQueued || searching) return;
    setEnterQueued(null);
    run(items[sel], enterQueued.newTab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enterQueued, searching]);

  let lastSection = "";
  return (
    <div className="qs">
      <div className="palette qs-panel" role="dialog" aria-label="Schnellsuche">
        <div className="pal-input">
          <Search size={16} className="faint" />
          <input
            ref={input}
            value={q}
            placeholder="Seiten, Inhalte, Buchungen – oder /zeit …"
            aria-label="Schnellsuche"
            aria-controls="qs-list"
            spellCheck={false}
            autoFocus
            onChange={(e) => {
              setQ(e.target.value);
              setSel(0);
              setNotice(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSel((v) => (v + 1) % Math.max(items.length, 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSel((v) => (v - 1 + items.length) % Math.max(items.length, 1));
              } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                if (searching) setEnterQueued({ newTab: e.ctrlKey || e.metaKey });
                else run(items[sel], e.ctrlKey || e.metaKey);
              } else if (e.key === "Escape") {
                e.preventDefault();
                hide();
              }
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="pal-list qs-list" id="qs-list" ref={list} role="listbox" aria-label="Ergebnisse">
          {items.length === 0 && <div className="pal-empty">Keine Ergebnisse</div>}
          {items.map((it, i) => {
            const header = it.section !== lastSection ? it.section : null;
            lastSection = it.section;
            return (
              <div key={it.id}>
                {header && <div className="pal-section">{header}</div>}
                <div
                  role="option"
                  aria-selected={i === sel}
                  data-action={it.action.type}
                  className={`pal-item ${i === sel ? "sel" : ""}`}
                  onMouseMove={() => sel !== i && setSel(i)}
                  onClick={(e) => run(it, e.ctrlKey || e.metaKey)}
                >
                  <span className="pal-icon">{it.action.type === "page" ? <PageIcon name={it.icon} size={16} /> : (ACTION_ICONS[it.action.type] ?? ic(Search))}</span>
                  <span className="pal-text">
                    <span className="pal-title">
                      {it.title}
                      {it.subtitle && <span className="pal-sub">{it.subtitle}</span>}
                    </span>
                    {it.snippet && <span className="pal-snippet" dangerouslySetInnerHTML={{ __html: snippetHtml(it.snippet) }} />}
                  </span>
                  {i === sel && <ArrowRight size={14} className="faint" />}
                </div>
              </div>
            );
          })}
        </div>
        <div className={`pal-foot ${notice?.error ? "qs-error" : ""}`} role={notice ? (notice.error ? "alert" : "status") : undefined}>
          {notice ? (
            <span className="qs-notice">{notice.text}</span>
          ) : (
            <>
              <span><kbd>↑</kbd><kbd>↓</kbd> wählen</span>
              <span><kbd>Enter</kbd> öffnen</span>
              <span><kbd>{keys("Mod Enter")}</kbd> neuer Tab</span>
              <span className="grow" />
              <span className="faint">/zeit bucht</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
