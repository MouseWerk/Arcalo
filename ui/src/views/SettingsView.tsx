// Settings: grouped sections with a search over all rows. The connection sections (KI,
// Netzwerk, Sicherung, Desktop) and the preferences (Darstellung, Editor, Notizen, Zeit,
// Benachrichtigungen, Datenschutz, Start, Sprache, Tastatur) plus Verwaltung, Protokoll and Über.

import { AnnaloLogo } from "../components/Logo";
import { useEffect, useMemo, useRef, useState, useLayoutEffect } from "react";
import { Bell, CalendarRange, CheckCircle2, Compass, ChevronRight, DatabaseBackup, Download, ExternalLink, Globe, Monitor, Eye, EyeOff, FolderInput, FolderOpen, FolderOutput, Keyboard, KeyRound, Languages, Loader2, Palette, PenLine, PlugZap, Plus, Power, RefreshCw, ScrollText, Search, Server, Shield, SlidersHorizontal, Sparkles, Timer, Trash2, NotebookPen, Info, Upload, X, XCircle } from "lucide-react";
import { api, on } from "../lib/api";
import { collapsePages, foldersBelow } from "../lib/collapsed";
import { useApp } from "../store/app";
import { applyTheme, exportVault, importVault, pickFolder } from "../lib/actions";
import { flushAllEditors } from "../editor/NoteEditor";
import { dateTime, decimal, fileSize, fmtDate, importSummary, relative, weekdayLabels } from "../lib/format";
import { Badge, Button, Field, IconButton, Input, Select, Switch, TextArea } from "../components/ui";
import { formatShortcut, keys } from "../lib/shortcut";
import { IS_LINUX, IS_MAC } from "../lib/platform";
import { ShortcutField } from "./settings/common";
import { NOT_CONFIGURED } from "../lib/updates";
import { checkForUpdates, loadUpdateStatus, UpdateAction, useUpdates } from "../components/Updates";
import { useT, t, type TKey } from "../lib/i18n";
import { COMMANDS, comboLabel, effectiveKeymap } from "../lib/keymap";
import type { BackupInfo, MirrorStatus, DataDirStatus, DesktopInfo, GitSyncMode, GitSyncSettings, GitSyncStatus, GitTest, Page, Settings } from "../lib/types";
import { CommitInput, FilterContext, Group, NumberInput, PathValue, Row, StatusNote, matches, useNoneBelow } from "./settings/common";
import { AppearanceSection } from "./settings/AppearanceSection";
import { EditorSection } from "./settings/EditorSection";
import { LocaleSection, NotesPrefGroups, NotificationsSection, PrivacySection, StartSection, TimePrefGroups } from "./settings/PrefSections";
import { AiPrefGroups } from "./settings/AiPrefGroups";
import { AiProvidersSection } from "./settings/AiProvidersSection";
import { KeyboardSection } from "./settings/KeyboardSection";
import { NetworkSection, withPacResults } from "./settings/NetworkSection";
import { AdminSection } from "./settings/AdminSection";
import { DevLogAboutRow, DevLogSection } from "./settings/DevLogSection";
import { CalendarSection } from "./settings/CalendarSection";
import { BackupDestinationsGroup, BackupList } from "./settings/BackupDestinations";
import { takeSettingsSection } from "../lib/calnav";
import { resetOnboarding, startFirstRun } from "../onboarding/state";

type Section = "appearance" | "locale" | "start" | "keyboard" | "editor" | "notes" | "time" | "calendar" | "ai" | "privacy" | "network" | "notifications" | "backup" | "desktop" | "admin" | "logs" | "about";
const NAV: { label: TKey; items: { id: Section; label: TKey; icon: typeof Server }[] }[] = [
  {
    label: "navgroup.general",
    items: [
      { id: "appearance", label: "nav.appearance", icon: Palette },
      { id: "locale", label: "nav.locale", icon: Languages },
      { id: "start", label: "nav.start", icon: Power },
      { id: "keyboard", label: "nav.keyboard", icon: Keyboard },
    ],
  },
  {
    label: "navgroup.work",
    items: [
      { id: "editor", label: "nav.editor", icon: PenLine },
      { id: "notes", label: "nav.notes", icon: NotebookPen },
      { id: "time", label: "nav.time", icon: Timer },
      { id: "calendar", label: "nav.calendar", icon: CalendarRange },
    ],
  },
  {
    label: "navgroup.ai",
    items: [
      { id: "ai", label: "nav.ai", icon: Sparkles },
      { id: "privacy", label: "nav.privacy", icon: Shield },
    ],
  },
  {
    label: "navgroup.system",
    items: [
      { id: "network", label: "nav.network", icon: Globe },
      { id: "notifications", label: "nav.notifications", icon: Bell },
      { id: "backup", label: "nav.backup", icon: DatabaseBackup },
      { id: "desktop", label: "nav.desktop", icon: Monitor },
      { id: "admin", label: "nav.admin", icon: SlidersHorizontal },
      { id: "logs", label: "nav.devlog", icon: ScrollText },
      { id: "about", label: "nav.about", icon: Info },
    ],
  },
];
/** Sections that save every change immediately (no save bar). */
const INSTANT = new Set<Section>(["appearance", "locale", "backup", "logs", "about", "calendar"]);

export function SettingsView() {
  const t = useT();
  const view = useApp((s) => s.settings);
  const [section, setSection] = useState<Section>(() => (takeSettingsSection() as Section | null) ?? "ai");
  // Opened on a section from elsewhere (the Kalender view, a toast) while already open.
  useEffect(() => {
    const onRequest = () => {
      const want = takeSettingsSection() as Section | null;
      if (want) {
        setQuery("");
        setSection(want);
      }
    };
    window.addEventListener("annalo:settings-section", onRequest);
    return () => window.removeEventListener("annalo:settings-section", onRequest);
  }, []);
  const nav = useRef<HTMLElement>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState(0);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const pending = useRef(0);
  const scroll = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const s = useApp.getState;
  // The open section stays visible in a long menu (only the menu scrolls, never the pane).
  useEffect(() => {
    const list = nav.current?.querySelector<HTMLElement>(".settings-nav-list");
    const item = list?.querySelector<HTMLElement>(`.settings-nav-item[data-section="${section}"]`);
    if (!list || !item || list.scrollHeight <= list.clientHeight) return;
    const r = item.getBoundingClientRect();
    const box = list.getBoundingClientRect();
    if (r.top < box.top || r.bottom > box.bottom) list.scrollTop += r.top - box.top - (list.clientHeight - r.height) / 2;
  }, [section, !!draft]);
  // A new section starts at its top.
  useLayoutEffect(() => {
    scroll.current?.scrollTo({ top: 0 });
  }, [section]);
  // Search results: how many rows match (sections and groups hide themselves when none do).
  const searching = query.trim().length > 0;
  useLayoutEffect(() => {
    const el = body.current;
    if (!el || !searching) return;
    const count = () => setHits(el.querySelectorAll(".settings-hit-section:not([hidden]) .set-group:not([hidden]) .set-row").length);
    count();
    const watch = new MutationObserver(count);
    watch.observe(el, { subtree: true, childList: true, attributes: true, attributeFilter: ["hidden"] });
    return () => watch.disconnect();
  }, [searching, !!draft]);

  useEffect(() => {
    if (!view) s().refreshSettings();
    // While instant saves are still running the draft is ahead of the stored settings: keep it.
    else if (!pending.current) setDraft(structuredClone(view.settings));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  // The start page saves its widgets itself; they are not part of this form.
  const dirty = useMemo(
    () => !!view && !!draft && JSON.stringify({ ...view.settings, dashboard: null }) !== JSON.stringify({ ...draft, dashboard: null }),
    [view, draft],
  );
  if (!view || !draft) return null;

  const update = (patch: Partial<Settings>) => setDraft({ ...draft, ...patch });
  const save = async (next = draft): Promise<boolean> => {
    if (next.thresholds.warning >= next.thresholds.critical) {
      s().toast({ tone: "warning", title: t("settings.notSaved"), detail: t("settings.thresholdOrder") });
      return false;
    }
    setSaving(true);
    try {
      let toSave = next;
      // PAC: the answers for the app's hosts are computed here (the core has no JS engine).
      if (toSave.network.mode === "pac") toSave = await withPacResults(toSave);
      const saved = await api.saveSettings(toSave);
      s().set({ settings: saved });
      applyTheme(saved.settings.theme);
      s().toast({ tone: "success", title: t("settings.saved") });
      return true;
    } catch (e) {
      s().error(t("settings.saveFailed"), e);
      return false;
    } finally {
      setSaving(false);
    }
  };
  const instant = (p: Partial<Settings>) => {
    const next = { ...draft, ...p };
    setDraft(next);
    // One save after the other: with quick clicks the last choice is the one that stays.
    pending.current++;
    queue.current = queue.current
      .then(() => save(next))
      .finally(() => {
        // The last one done: the draft follows what is stored now.
        if (--pending.current === 0) {
          const stored = useApp.getState().settings;
          if (stored) setDraft(structuredClone(stored.settings));
        }
      });
  };
  const updaterFor = (id: Section) => (INSTANT.has(id) ? instant : update);

  const render = (id: Section) => {
    const u = updaterFor(id);
    switch (id) {
      case "appearance":
        return <AppearanceSection draft={draft} update={u} />;
      case "locale":
        return <LocaleSection draft={draft} update={u} />;
      case "start":
        return <StartSection draft={draft} update={u} />;
      case "keyboard":
        return <KeyboardSection draft={draft} update={u} />;
      case "editor":
        return <EditorSection draft={draft} update={u} />;
      case "notes":
        return (
          <>
            <NotesSection draft={draft} update={u} />
            <NotesPrefGroups draft={draft} update={u} />
          </>
        );
      case "time":
        return (
          <>
            <TimeSection draft={draft} update={u} />
            <TimePrefGroups draft={draft} update={u} />
          </>
        );
      case "ai":
        return (
          <>
            <AiSection draft={draft} update={u} />
            <AiPrefGroups draft={draft} update={u} />
          </>
        );
      case "calendar":
        return <CalendarSection draft={draft} update={u} />;
      case "privacy":
        return <PrivacySection draft={draft} update={u} />;
      case "network":
        return <NetworkSection draft={draft} update={u} />;
      case "notifications":
        return <NotificationsSection draft={draft} update={u} />;
      case "backup":
        return <BackupSection draft={draft} update={u} />;
      case "desktop":
        return <DesktopSection draft={draft} update={u} />;
      case "admin":
        return <AdminSection save={save} />;
      case "logs":
        return <DevLogSection draft={draft} update={u} />;
      case "about":
        return <AboutSection draft={draft} update={u} onOpenLog={() => setSection("logs")} />;
    }
  };

  const all = NAV.flatMap((g) => g.items);
  const open = (id: Section) => {
    setQuery("");
    setSection(id);
  };
  const search = (
    <div className="settings-search">
      <Search size={14} className="faint" aria-hidden />
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t("settings.searchShort")}
        aria-label={t("settings.search")}
        spellCheck={false}
        onKeyDown={(e) => {
          if (e.key === "Escape") setQuery("");
          // Enter opens the first section with a hit.
          if (e.key === "Enter") {
            const first = body.current?.querySelector<HTMLElement>(".settings-hit-section:not([hidden])")?.dataset.section as Section | undefined;
            if (first) open(first);
          }
        }}
      />
      {searching ? <IconButton icon={X} label={t("common.clear")} size="sm" onClick={() => setQuery("")} /> : <kbd className="settings-search-key">{keys("Mod F")}</kbd>}
    </div>
  );
  return (
    <div
      className={`settings ${searching ? "searching" : ""}`}
      onKeyDown={(e) => {
        // Mod+F inside the settings goes to their search.
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "f") {
          e.preventDefault();
          e.currentTarget.querySelector<HTMLInputElement>(".settings-search input")?.focus();
        }
      }}
    >
      <nav className="settings-nav" ref={nav} aria-label={t("settings.title")}>
        <div className="settings-nav-title">{t("settings.title")}</div>
        {search}
        <div className="settings-nav-list">
          {NAV.map((g) => (
            <div key={g.label} className="settings-nav-group" role="group" aria-label={t(g.label)}>
              <div className="settings-nav-group-label">{t(g.label)}</div>
              {g.items.map((x) => (
                <button
                  key={x.id}
                  type="button"
                  data-section={x.id}
                  aria-current={!searching && section === x.id ? "page" : undefined}
                  className={`settings-nav-item ${!searching && section === x.id ? "active" : ""}`}
                  onClick={() => open(x.id)}
                >
                  <x.icon size={15} strokeWidth={1.75} aria-hidden />
                  {t(x.label)}
                </button>
              ))}
            </div>
          ))}
        </div>
      </nav>
      {/* Narrow panes: the menu becomes a section dropdown next to the search. */}
      <div className="settings-topbar">
        {search}
        <Select
          className="settings-section-select"
          aria-label={t("settings.section")}
          value={searching ? "" : section}
          placeholder={t("settings.results", { n: hits })}
          options={NAV.flatMap((g) => g.items.map((x, i) => ({ value: x.id, label: t(x.label), icon: x.icon, ...(i === 0 ? { group: t(g.label) } : {}) })))}
          onChange={(e) => open(e.target.value as Section)}
        />
      </div>
      <div className="settings-scroll" ref={scroll}>
        <div className="settings-body" ref={body}>
          {searching ? (
            <>
              <div className="settings-search-head" role="status">
                {hits ? t("settings.results", { n: hits }) : t("settings.noHits", { query: query.trim() })}
              </div>
              {all.map((x) => (
                // A section whose name matches shows all its rows.
                <FilterContext.Provider key={x.id} value={matches(query, t(x.label)) ? "" : query}>
                  <SearchSection id={x.id} icon={x.icon} title={t(x.label)} onOpen={() => open(x.id)}>
                    {render(x.id)}
                  </SearchSection>
                </FilterContext.Provider>
              ))}
            </>
          ) : (
            render(section)
          )}
        </div>
        {dirty && (
          <div className="savebar" role="region" aria-label={t("settings.unsaved")}>
            <span>{t("settings.unsaved")}</span>
            <Button variant="ghost" onClick={() => setDraft(structuredClone(view.settings))}>
              {t("common.discard")}
            </Button>
            <Button variant="primary" onClick={() => save()} loading={saving}>
              {t("common.save")}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

/** One section in the search results; hidden when none of its rows match. */
function SearchSection({ id, icon: Icon, title, onOpen, children }: { id: Section; icon: typeof Server; title: string; onOpen: () => void; children: React.ReactNode }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const empty = useNoneBelow(ref, ".set-group:not([hidden]) .set-row", true);
  return (
    <div className="settings-hit-section" hidden={empty} ref={ref} data-section={id}>
      <button type="button" className="settings-hit-title" onClick={onOpen} title={t("settings.openSection")}>
        <Icon size={14} strokeWidth={1.75} aria-hidden />
        <span>{title}</span>
        <ChevronRight size={14} className="settings-hit-arrow" aria-hidden />
      </button>
      <div className="settings-hit-body">{children}</div>
    </div>
  );
}

// -------------------------------------------------------------------- AI

function AiSection({ draft, update }: { draft: Settings; update: (p: Partial<Settings>) => void }) {
  const t = useT();
  return (
    <>
      <header className="settings-head">
        <h1>{t("set.ai.title")}</h1>
        <p>{t("set.ai.intro")}</p>
      </header>

      <AiProvidersSection draft={draft} update={update} />

      <Group title={t("set.ai.behavior")}>
        <Field label={t("set.ai.instructions")} hint={t("set.ai.instructionsHint")}>
          <TextArea rows={4} value={draft.assistant_instructions} onChange={(e) => update({ assistant_instructions: e.target.value })} placeholder={t("set.ai.instructionsPlaceholder")} />
        </Field>
      </Group>
    </>
  );
}

// ------------------------------------------------------------------ time

function TimeSection({ draft, update }: { draft: Settings; update: (p: Partial<Settings>) => void }) {
  const t = useT();
  const [las, setLas] = useState<[string, string][]>([]);
  const [newLa, setNewLa] = useState({ code: "", desc: "" });
  const [mapKey, setMapKey] = useState("");
  const [mapVal, setMapVal] = useState("");
  const s = useApp.getState;
  const reload = () => api.leistungsarten().then(setLas);
  useEffect(() => {
    reload();
  }, []);
  const pct = (x: number) => Math.round(x * 100);

  return (
    <>
      <header className="settings-head">
        <h1>{t("set.time.title")}</h1>
        <p>{t("set.time.intro")}</p>
      </header>
      <Group title={t("set.time.use")}>
        <Row label={t("set.time.useLabel")} description={t("set.time.useDesc")}>
          <Switch label={t("set.time.useLabel")} checked={draft.time.enabled !== false} onChange={(v) => update({ time: { ...draft.time, enabled: v } })} />
        </Row>
      </Group>
      <Group title={t("set.time.timer")}>
        <Row label={t("set.time.idle")} description={t("set.time.idleDesc")}>
          <div className="unit-input">
            <NumberInput min={1} max={120} value={draft.idle_threshold_minutes} onCommit={(v) => update({ idle_threshold_minutes: v })} aria-label={t("unit.minutes")} />
            <span className="faint">{t("unit.minutes")}</span>
          </div>
        </Row>
      </Group>
      <Group title={t("set.time.workTime")} description={t("set.time.workTimeDesc")}>
        <Row label={t("set.time.target")}>
          <div className="unit-input">
            <NumberInput min={0.5} max={16} step={0.25} value={draft.daily_target_hours} onCommit={(v) => update({ daily_target_hours: v })} aria-label={t("unit.hoursLong")} />
            <span className="faint">{t("unit.hoursLong")}</span>
          </div>
        </Row>
        <Row label={t("set.time.workdays")}>
          <div className="day-toggle" role="group" aria-label={t("set.time.workdays")}>
            {weekdayLabels(1).map((d, i) => {
              const on = draft.workdays.includes(i + 1);
              return (
                <button
                  key={d}
                  type="button"
                  aria-pressed={on}
                  className={on ? "on" : ""}
                  onClick={() => update({ workdays: on ? draft.workdays.filter((x) => x !== i + 1) : [...draft.workdays, i + 1].sort() })}
                >
                  {d}
                </button>
              );
            })}
          </div>
        </Row>
      </Group>
      <Group title={t("set.time.budget")} description={t("set.time.budgetDesc")}>
        <Row label={t("set.time.warnAt")}>
          <div className="unit-input">
            <NumberInput min={1} max={100} value={pct(draft.thresholds.warning)} onCommit={(v) => update({ thresholds: { ...draft.thresholds, warning: v / 100 } })} aria-label={t("set.time.warnPercent")} />
            <span className="faint">{t("set.time.percentUsed")}</span>
          </div>
        </Row>
        <Row label={t("set.time.criticalAt")} description={t("set.time.criticalDesc")}>
          <div className="unit-input">
            <NumberInput min={1} max={100} value={pct(draft.thresholds.critical)} onCommit={(v) => update({ thresholds: { ...draft.thresholds, critical: v / 100 } })} aria-label={t("set.time.criticalPercent")} />
            <span className="faint">{t("set.time.percentUsed")}</span>
          </div>
        </Row>
        {pct(draft.thresholds.warning) >= pct(draft.thresholds.critical) && (
          <p className="error-note small" role="alert">{t("settings.thresholdOrder")}</p>
        )}
      </Group>
      <Group title="SAP CATS">
        <Row label={t("set.time.pernr")}>
          <Input value={draft.pernr ?? ""} onChange={(e) => update({ pernr: e.target.value || null })} placeholder="00012345" aria-label={t("set.time.pernr")} />
        </Row>
      </Group>
      <Group title={t("set.time.jira")} description={t("set.time.jiraDesc")}>
        <div className="map-list">
          {Object.entries(draft.jira_issue_map).map(([k, v]) => (
            <div key={k} className="map-row">
              <span className="mono">{k}</span>
              <span className="faint">→</span>
              <span className="mono">{v}</span>
              <span className="grow" />
              <IconButton
                icon={Trash2}
                label={t("common.remove")}
                size="sm"
                onClick={() => {
                  const m = { ...draft.jira_issue_map };
                  delete m[k];
                  update({ jira_issue_map: m });
                }}
              />
            </div>
          ))}
          <div className="map-row">
            <Input value={mapKey} onChange={(e) => setMapKey(e.target.value)} placeholder="NP-8801/1020" className="mono" aria-label={t("set.time.jiraKey")} />
            <span className="faint">→</span>
            <Input value={mapVal} onChange={(e) => setMapVal(e.target.value)} placeholder="AET-12" className="mono" aria-label={t("set.time.jiraIssue")} />
            <Button
              icon={Plus}
              disabled={!mapKey.trim() || !mapVal.trim()}
              onClick={() => {
                update({ jira_issue_map: { ...draft.jira_issue_map, [mapKey.trim()]: mapVal.trim() } });
                setMapKey("");
                setMapVal("");
              }}
            >
              {t("common.add")}
            </Button>
          </div>
        </div>
      </Group>
      <Group title={t("set.time.leistungsarten")} description={t("set.time.leistungsartenDesc")}>
        <div className="map-list">
          {las.map(([code, desc]) => (
            <div key={code} className="map-row">
              <Badge>{code}</Badge>
              <span>{desc}</span>
              <span className="grow" />
              <IconButton
                icon={Trash2}
                label={t("common.delete")}
                size="sm"
                onClick={async () => {
                  try {
                    await api.deleteLeistungsart(code);
                    reload();
                    s().bumpWbs();
                  } catch (e) {
                    s().error(t("common.deleteFailed"), e);
                  }
                }}
              />
            </div>
          ))}
          <div className="map-row">
            <Input value={newLa.code} onChange={(e) => setNewLa({ ...newLa, code: e.target.value.toUpperCase() })} placeholder="CODE" className="mono w-120" aria-label={t("set.time.laCode")} />
            <Input value={newLa.desc} onChange={(e) => setNewLa({ ...newLa, desc: e.target.value })} placeholder={t("set.time.laDesc")} aria-label={t("set.time.laDesc")} />
            <Button
              icon={Plus}
              disabled={!newLa.code.trim()}
              onClick={async () => {
                try {
                  await api.saveLeistungsart(newLa.code, newLa.desc);
                  setNewLa({ code: "", desc: "" });
                  reload();
                  s().bumpWbs();
                } catch (e) {
                  s().error(t("common.saveFailed"), e);
                }
              }}
            >
              {t("common.add")}
            </Button>
          </div>
        </div>
      </Group>
    </>
  );
}

// ----------------------------------------------------------------- notes

function NotesSection({ draft, update }: { draft: Settings; update: (p: Partial<Settings>) => void }) {
  const t = useT();
  const [path, setPath] = useState("");
  const [templates, setTemplates] = useState<Page[]>([]);
  useEffect(() => {
    api.templates().then(setTemplates, () => {});
  }, []);
  const missing = draft.daily_template != null && !templates.some((t) => t.id === draft.daily_template);
  return (
    <>
      <header className="settings-head">
        <h1>{t("set.notes.title")}</h1>
        <p>{t("set.notes.intro")}</p>
      </header>
      <Group title={t("set.notes.templates")}>
        <Row label={t("set.notes.dailyTemplate")} description={t("set.notes.dailyTemplateDesc")}>
          <Select
            value={draft.daily_template == null ? "" : String(draft.daily_template)}
            onChange={(e) => update({ daily_template: e.target.value ? Number(e.target.value) : null })}
            aria-label={t("set.notes.dailyTemplate")}
            className="w-360"
          >
            <option value="">{t("set.notes.dailyTemplateDefault")}</option>
            {missing && templates.length > 0 && <option value={String(draft.daily_template)}>{t("set.notes.deletedTemplate")}</option>}
            {templates.map((x) => (
              <option key={x.id} value={String(x.id)}>
                {x.title}
              </option>
            ))}
          </Select>
        </Row>
      </Group>
      <Group title="Obsidian" description={t("set.notes.obsidianDesc")}>
        <Row label={t("set.notes.importVault")}>
          <Button icon={FolderInput} onClick={() => importVault()}>
            {t("common.chooseFolder")}
          </Button>
        </Row>
        <Row stack label={t("set.notes.path")} description={t("set.notes.pathDesc")}>
          <Input value={path} onChange={(e) => setPath(e.target.value)} placeholder={t("set.notes.pathPlaceholder")} className="grow" aria-label={t("set.notes.vaultPath")} />
          <Button onClick={() => path.trim() && importVault(path.trim())} disabled={!path.trim()}>
            {t("common.import")}
          </Button>
        </Row>
        <Row label={t("set.notes.exportMd")} description={t("set.notes.exportMdDesc")}>
          <Button icon={FolderOutput} onClick={() => exportVault()}>
            {t("set.notes.chooseTarget")}
          </Button>
        </Row>
      </Group>
      <Group title={t("set.notes.samples")}>
        <Row label={t("set.notes.removeSamples")} description={t("set.notes.removeSamplesDesc")}>
          <Button
            variant="danger"
            icon={Trash2}
            onClick={async () => {
              const s = useApp.getState();
              if (!(await s.confirm({ title: t("set.notes.removeSamplesAsk"), message: t("set.notes.removeSamplesText"), confirmLabel: t("common.remove"), danger: true }))) return;
              try {
                const n = await api.removeDemo();
                await s.refreshTree();
                s.bumpWbs();
                s.bumpEntries();
                s.toast({ tone: "success", title: t("set.notes.samplesRemoved"), detail: n ? t("set.notes.samplesRemovedPages") : t("set.notes.samplesRemovedProject") });
              } catch (e) {
                s.error(t("common.removeFailed"), e);
              }
            }}
          >
            {t("common.remove")}
          </Button>
        </Row>
      </Group>
    </>
  );
}

function BackupSection({ draft, update }: { draft: Settings; update: (p: Partial<Settings>) => void }) {
  const t = useT();
  const view = useApp((s) => s.settings)!;
  const [list, setList] = useState<BackupInfo[] | null>(null);
  const [mirror, setMirror] = useState<MirrorStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const s = useApp.getState;
  const reload = () => {
    api.backups().then(setList).catch(() => setList([]));
    api.mirrorStatus().then(setMirror).catch(() => setMirror(null));
  };
  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.backup_dir, view.settings.backup_keep, view.settings.markdown_mirror, view.settings.markdown_mirror_dir]);

  const pickMirror = async () => {
    const dir = await pickFolder(t("set.backup.mirrorPick"));
    if (dir) update({ markdown_mirror_dir: dir });
  };
  const openMirror = async () => {
    try {
      await api.openMirror();
    } catch (e) {
      s().error(t("common.openFolderFailed"), e);
    }
  };

  const pick = async () => {
    const dir = await pickFolder(t("set.backup.pick"));
    if (dir) update({ backup_dir: dir });
  };
  const backupNow = async () => {
    setBusy(true);
    try {
      const b = await api.backupNow();
      const copies = draft.backup_targets.destinations.some((d) => d.enabled) ? ` · ${t("bdest.backupDone")}` : "";
      s().toast({ tone: "success", title: t("set.backup.created"), detail: `${b.file_name} · ${fileSize(b.size_bytes)}${copies}` });
      reload();
    } catch (e) {
      s().error(t("set.backup.failed"), e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <header className="settings-head">
        <h1>{t("set.backup.title")}</h1>
        <p>{t("bdest.contents")}</p>
      </header>
      <Group title={t("set.backup.auto")} description={t("set.backup.autoDesc")}>
        <Row
          label={t("common.folder")}
          description={
            <>
              <span>{draft.backup_dir ? t("set.backup.ownFolder") : t("set.backup.defaultFolder")}</span>
              <PathValue value={view.backup_dir} className="backup-path" />
            </>
          }
        >
          <Button icon={FolderOpen} onClick={pick}>
            {t("common.chooseFolder")}
          </Button>
          {draft.backup_dir && (
            <Button variant="ghost" onClick={() => update({ backup_dir: null })}>
              {t("common.default")}
            </Button>
          )}
        </Row>
        <Row label={t("set.backup.keep")} description={t("set.backup.keepDesc")}>
          <div className="unit-input">
            <NumberInput min={1} max={365} value={draft.backup_keep} onCommit={(v) => update({ backup_keep: v })} aria-label={t("set.backup.keepCount")} />
            <span className="faint">{t("set.backup.backupsUnit")}</span>
          </div>
        </Row>
      </Group>
      <Group title={t("set.backup.mirrorTitle")} description={t("set.backup.mirrorDesc")}>
        <Row label={t("set.backup.mirror")}>
          <Switch label={t("set.backup.mirrorSwitch")} checked={draft.markdown_mirror} onChange={(v) => update({ markdown_mirror: v })} />
        </Row>
        {draft.markdown_mirror && (
          <>
            <Row
              label={t("common.folder")}
              description={
                <>
                  <span>{draft.markdown_mirror_dir ? t("set.backup.mirrorOwn") : t("set.backup.mirrorDefault")}</span>
                  {mirror?.path ? <PathValue value={mirror.path} className="backup-path mirror-path" /> : null}
                </>
              }
            >
              <Button icon={FolderOpen} onClick={pickMirror}>
                {t("common.chooseFolder")}
              </Button>
              {draft.markdown_mirror_dir && (
                <Button variant="ghost" onClick={() => update({ markdown_mirror_dir: null })}>
                  {t("common.default")}
                </Button>
              )}
            </Row>
            <Row
              label={t("set.backup.mirrorLast")}
              description={
                mirror?.error ? (
                  <span className="mirror-error">{t("common.failedWith", { msg: mirror.error })}</span>
                ) : mirror?.last_at ? (
                  <span className="mirror-last">
                    {dateTime(mirror.last_at)} · {relative(mirror.last_at)}
                  </span>
                ) : (
                  t("set.backup.mirrorNone")
                )
              }
            >
              <Button icon={ExternalLink} onClick={openMirror} disabled={!mirror?.last_at}>
                {t("common.openFolder")}
              </Button>
            </Row>
          </>
        )}
      </Group>
      <Group title={t("set.backup.backups")}>
        <Row label={t("set.backup.now")} description={t("set.backup.nowDesc")}>
          <Button icon={DatabaseBackup} onClick={backupNow} loading={busy}>
            {t("set.backup.nowButton")}
          </Button>
        </Row>
        <BackupList local={list} reloadKey={list} />
      </Group>
      <BackupDestinationsGroup draft={draft} update={update} />
      <GitSyncGroup draft={draft} update={update} dbSize={list?.[0]?.size_bytes ?? null} onSynced={reload} />
    </>
  );
}

const BIG_DB = 50 * 1024 * 1024;

function GitSyncGroup({ draft, update, dbSize, onSynced }: { draft: Settings; update: (p: Partial<Settings>) => void; dbSize: number | null; onSynced: () => void }) {
  const t = useT();
  const git = draft.git_sync;
  const setGit = (p: Partial<GitSyncSettings>) => update({ git_sync: { ...git, ...p } });
  const [status, setStatus] = useState<GitSyncStatus | null>(null);
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [test, setTest] = useState<GitTest | null>(null);
  const [testing, setTesting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [restoreUrl, setRestoreUrl] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const s = useApp.getState;

  const reload = () => api.gitSyncStatus().then(setStatus).catch(() => setStatus(null));
  useEffect(() => {
    reload();
    const off = [on("gitsync://done", reload), on("gitsync://failed", reload)];
    return () => off.forEach((p) => p.then((f) => f()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [git.remote_url, git.branch, git.include_database, draft.markdown_mirror]);

  const saveToken = async (value: string | null) => {
    try {
      setStatus(await api.setGitToken(value));
      setToken("");
      s().toast({ tone: "success", title: value ? t("set.git.tokenSaved") : t("set.git.tokenRemoved") });
    } catch (e) {
      s().error(t("set.git.tokenFailed"), e);
    }
  };
  const runTest = async () => {
    setTesting(true);
    try {
      setTest(await api.gitSyncTest(git.remote_url || null, token.trim() || null));
    } catch (e) {
      setTest({ ok: false, latency_ms: 0, branches: [], error: String(e) });
    } finally {
      setTesting(false);
    }
  };
  const syncNow = async (allowDeletions = false) => {
    if (allowDeletions) {
      const n = status?.blocked_deletions ?? 0;
      const ok = await s().confirm({
        title: t("set.git.deleteAsk"),
        message: t("set.git.deleteText", { n }),
        confirmLabel: t("set.git.deleteConfirm"),
        danger: true,
      });
      if (!ok) return;
    }
    setSyncing(true);
    try {
      const r = await api.gitSyncNow(allowDeletions);
      s().toast({ tone: r.fallback ? "warning" : "success", title: r.committed ? t("set.git.synced") : t("set.git.upToDate"), detail: r.fallback ? r.message : `${r.message}${r.commit ? ` · ${r.commit}` : ""}` });
      onSynced();
    } catch {
      // The shell emits gitsync://failed, which shows the toast; the status line shows the error.
    } finally {
      setSyncing(false);
      reload();
    }
  };
  const restore = async () => {
    if (!restoreUrl?.trim()) return;
    setRestoring(true);
    try {
      const r = await api.gitRestoreImport(restoreUrl.trim());
      await s().refreshTree();
      collapsePages(foldersBelow(useApp.getState().pages.get(r.root_page_id)));
      s().openPage(r.root_page_id);
      s().toast({ tone: "success", title: t("set.git.imported"), detail: importSummary(r) });
      setRestoreUrl(null);
    } catch (e) {
      s().error(t("set.git.restoreFailed"), e);
    } finally {
      setRestoring(false);
    }
  };

  const fallback = status?.last_branch && status.last_branch !== git.branch ? status.last_branch : null;
  return (
    <Group title={t("set.git.title")} description={t("set.git.desc")}>
      <Row label={t("set.git.title")} description={git.remote_url ? undefined : t("set.git.urlFirst")}>
        <Switch label={t("set.git.title")} checked={git.enabled} onChange={(v) => setGit({ enabled: v })} />
      </Row>
      <Row stack label={t("set.git.remote")} description={t("set.git.remoteDesc")}>
        <CommitInput value={git.remote_url} onCommit={(v) => setGit({ remote_url: v })} placeholder={t("set.git.remotePlaceholder")} aria-label={t("set.git.remote")} className="grow" />
      </Row>
      <Row label={t("set.git.branch")}>
        <CommitInput value={git.branch} onCommit={(v) => setGit({ branch: v || "main" })} placeholder="main" aria-label={t("set.git.branch")} />
      </Row>
      <Row label={t("set.git.author")} description={t("set.git.authorDesc")}>
        <CommitInput value={git.author_name} onCommit={(v) => setGit({ author_name: v })} placeholder={t("set.git.authorName")} aria-label={t("set.git.authorNameLabel")} />
        <CommitInput value={git.author_email} onCommit={(v) => setGit({ author_email: v })} placeholder={t("set.git.authorEmail")} aria-label={t("set.git.authorEmailLabel")} />
      </Row>
      <Row
        stack
        label={t("set.git.token")}
        description={
          <>
            {status?.token_set ? <Badge tone="success">{t("common.saved")}</Badge> : <Badge>{t("common.notSet")}</Badge>}
            <span>{t("set.git.tokenDesc")}</span>
          </>
        }
      >
        <div className="key-input">
          <KeyRound size={14} className="faint" />
          <input
            type={showToken ? "text" : "password"}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={status?.token_set ? t("set.git.tokenReplace") : "ghp_… / glpat-…"}
            aria-label={t("set.git.tokenLabel")}
            autoComplete="off"
            spellCheck={false}
            onKeyDown={(e) => e.key === "Enter" && token.trim() && saveToken(token.trim())}
          />
          <IconButton icon={showToken ? EyeOff : Eye} label={showToken ? t("common.hide") : t("common.show")} size="sm" onClick={() => setShowToken(!showToken)} />
        </div>
        <Button variant="primary" onClick={() => saveToken(token.trim())} disabled={!token.trim()}>
          {t("common.save")}
        </Button>
        {status?.token_set && <IconButton icon={Trash2} label={t("set.git.tokenRemove")} onClick={() => saveToken(null)} />}
      </Row>
      <Row label={t("set.git.when")}>
        <Select value={git.mode} onChange={(e) => setGit({ mode: e.target.value as GitSyncMode })} aria-label={t("set.git.whenLabel")}>
          <option value="with_backup">{t("set.git.withBackup")}</option>
          <option value="hourly">{t("set.git.hourly")}</option>
        </Select>
      </Row>
      <Row
        label={t("set.git.database")}
        description={
          git.include_database ? (
            <span className={dbSize != null && dbSize > BIG_DB ? "mirror-error" : ""}>
              {dbSize != null ? t("set.git.databaseOnSize", { size: fileSize(dbSize) }) : t("set.git.databaseOn")}
            </span>
          ) : (
            t("set.git.databaseOff")
          )
        }
      >
        <Switch label={t("set.git.database")} checked={git.include_database} onChange={(v) => setGit({ include_database: v })} />
      </Row>
      <Row label={t("set.git.connection")} description={t("set.git.connectionDesc")}>
        <div className={`conn ${test ? (test.ok ? "ok" : "fail") : ""}`}>
          {testing ? (
            <>
              <Loader2 size={14} className="spin" /> {t("common.checking")}
            </>
          ) : test?.ok ? (
            <span className="git-test-ok">
              <CheckCircle2 size={14} /> {t("set.git.connected", { n: test.branches.length, ms: test.latency_ms })}
            </span>
          ) : test ? (
            <span title={test.error ?? ""}>
              <XCircle size={14} /> {t("set.ai.noConnection")}
            </span>
          ) : null}
        </div>
        <Button icon={PlugZap} onClick={runTest} disabled={testing || !git.remote_url}>
          {t("set.git.test")}
        </Button>
      </Row>
      {test && !test.ok && test.error && <p className="error-note mono small">{test.error}</p>}
      <Row
        label={t("set.git.last")}
        description={
          <span className="git-status">
            {status?.last_error ? (
              <span className="mirror-error">{t("common.failedWith", { msg: status.last_error })}</span>
            ) : status?.last_at ? (
              <span>
                {relative(status.last_at)}
                {status.last_commit ? ` · ${t("set.git.commit", { commit: status.last_commit })}` : ""}
                {fallback ? ` · ${t("set.git.onBranch", { branch: fallback })}` : ""}
              </span>
            ) : (
              <span>{t("set.git.never")}</span>
            )}
            {status && status.pending_changes > 0 && <span className="faint"> · {t("set.git.pending", { n: status.pending_changes })}</span>}
          </span>
        }
      >
        <Button icon={Upload} onClick={() => syncNow()} loading={syncing} disabled={!git.remote_url}>
          {t("set.git.syncNow")}
        </Button>
      </Row>
      {status?.blocked_deletions ? (
        <Row label={t("set.git.deletionsHeld")} description={t("set.git.deletionsHeldDesc", { n: status.blocked_deletions })}>
          <Button variant="danger" icon={Trash2} onClick={() => syncNow(true)} disabled={syncing}>
            {t("set.git.deletionsPush")}
          </Button>
        </Row>
      ) : null}
      <Row label={t("set.git.restore")} description={t("set.git.restoreDesc")}>
        <Button icon={Download} onClick={() => setRestoreUrl(restoreUrl == null ? git.remote_url : null)}>
          {t("set.git.restoreButton")}
        </Button>
      </Row>
      {restoreUrl != null && (
        <Row stack label={t("set.git.repoUrl")} description={t("set.git.repoUrlDesc")}>
          <Input value={restoreUrl} onChange={(e) => setRestoreUrl(e.target.value)} onKeyDown={(e) => e.key === "Enter" && restore()} aria-label={t("set.git.repoUrlLabel")} className="grow" autoFocus />
          <Button variant="primary" onClick={restore} loading={restoring} disabled={!restoreUrl.trim()}>
            {t("common.import")}
          </Button>
          <Button variant="ghost" onClick={() => setRestoreUrl(null)}>
            {t("common.cancel")}
          </Button>
        </Row>
      )}
    </Group>
  );
}

/** Wording of the window options: tray and login items are called differently on macOS. */
const DESK: Record<"closeLabel" | "closeHint" | "autostartLabel" | "autostartHint", TKey> = IS_MAC
  ? { closeLabel: "set.desktop.closeMac", closeHint: "set.desktop.closeHintMac", autostartLabel: "set.desktop.autostartMac", autostartHint: "set.desktop.autostartHintMac" }
  : { closeLabel: "set.desktop.close", closeHint: "set.desktop.closeHint", autostartLabel: "set.desktop.autostart", autostartHint: "set.desktop.autostartHint" };

function DesktopSection({ draft, update }: { draft: Settings; update: (p: Partial<Settings>) => void }) {
  const t = useT();
  const desk = { closeLabel: t(DESK.closeLabel), closeHint: t(DESK.closeHint), autostartLabel: t(DESK.autostartLabel), autostartHint: t(DESK.autostartHint) };
  const [info, setInfo] = useState<DesktopInfo | null>(null);
  const s = useApp.getState;
  const view = useApp((st) => st.settings);
  useEffect(() => {
    api.desktopInfo().then(setInfo, () => setInfo(null));
  }, [view]);
  const setAutostart = async (on: boolean) => {
    try {
      setInfo(await api.setAutostart(on));
    } catch (e) {
      s().error(t("set.desktop.autostartFailed"), e);
    }
  };
  const reminderOn = draft.reminder_time != null;

  return (
    <>
      <header className="settings-head">
        <h1>{t("nav.desktop")}</h1>
        <p>{IS_MAC ? t("set.desktop.introMac") : t("set.desktop.intro")}</p>
      </header>
      <Group title={t("set.desktop.window")}>
        <Row
          label={desk.closeLabel}
          description={
            <>
              {desk.closeHint}
              {info && !info.tray && !IS_MAC && <Badge tone="warning">{t("set.desktop.noTray")}</Badge>}
            </>
          }
        >
          <Switch label={desk.closeLabel} checked={draft.close_to_tray} onChange={(v) => update({ close_to_tray: v })} />
        </Row>
        <Row
          label={desk.autostartLabel}
          description={
            info?.portable ? (
              <>
                {desk.autostartHint} <Badge tone="info">{t("set.desktop.portableOff")}</Badge> {t("set.desktop.portableAutostart")}
              </>
            ) : (
              desk.autostartHint
            )
          }
        >
          <Switch label={desk.autostartLabel} checked={!!info?.autostart} onChange={setAutostart} disabled={!!info?.portable} />
        </Row>
      </Group>
      <Group title={t("cmd.palette")}>
        <Row label={t("set.desktop.globalShortcut")} description={t("set.desktop.paletteDesc", { example: keys("Mod Shift K"), always: keys("Mod K") })}>
          <ShortcutField
            value={draft.palette_shortcut ?? ""}
            onChange={(v) => update({ palette_shortcut: v || null })}
            label={t("set.desktop.paletteShortcut")}
            placeholder={t("common.egShortcut", { keys: `${IS_MAC ? "Cmd" : "Ctrl"}+Shift+K` })}
            active={info ? (draft.palette_shortcut ?? "") === (view?.settings.palette_shortcut ?? "") && info.palette_shortcut_active : undefined}
          />
        </Row>
      </Group>
      <Group title={t("set.desktop.search")} description={t("set.desktop.searchDesc")}>
        <Row label={t("set.desktop.globalShortcut")} description={t("set.desktop.searchShortcutDesc")}>
          <ShortcutField
            value={draft.search_shortcut}
            onChange={(v) => update({ search_shortcut: v })}
            label={t("set.desktop.searchShortcut")}
            placeholder={t("common.pressKeys")}
            active={info ? draft.search_shortcut === view?.settings.search_shortcut && info.search_shortcut_active : undefined}
          />
        </Row>
      </Group>
      <Group title={t("set.desktop.reminder")} description={t("set.desktop.reminderDesc")}>
        <Row label={t("set.desktop.remindAt")}>
          <div className="unit-input">
            {reminderOn && (
              <Input
                inputMode="numeric"
                pattern="([01]\d|2[0-3]):[0-5]\d"
                placeholder="17:30"
                maxLength={5}
                className="time-input num"
                value={draft.reminder_time ?? ""}
                onChange={(e) => update({ reminder_time: e.target.value })}
                aria-label={t("set.desktop.reminderTime")}
              />
            )}
            <span className="faint">{reminderOn ? t("unit.oclock") : t("common.off")}</span>
            <Switch label={t("set.desktop.reminder")} checked={reminderOn} onChange={(v) => update({ reminder_time: v ? "17:30" : null })} />
          </div>
        </Row>
      </Group>
      <Group title={t("set.capture.title")} description={t("set.capture.desc")}>
        <Row label={t("set.desktop.globalShortcut")} description={IS_MAC ? t("set.capture.shortcutDescMac", { example: formatShortcut("Cmd+Shift+Space") }) : t("set.capture.shortcutDesc")}>
          <ShortcutField
            value={draft.capture_shortcut}
            onChange={(v) => update({ capture_shortcut: v })}
            label={t("set.capture.shortcut")}
            placeholder={t("common.pressKeys")}
            active={info ? draft.capture_shortcut === view?.settings.capture_shortcut && info.capture_shortcut_active : undefined}
          />
        </Row>
        <Row
          label={t("set.capture.selection")}
          description={IS_LINUX ? t("set.capture.selectionDescLinux") : t("set.capture.selectionDesc", { copy: IS_MAC ? "⌘C" : t("keys.ctrlC") })}
        >
          <ShortcutField
            value={draft.capture.selection_shortcut}
            onChange={(v) => update({ capture: { ...draft.capture, selection_shortcut: v } })}
            label={t("set.capture.selectionShortcut")}
            placeholder={t("common.egShortcut", { keys: `${IS_MAC ? "Cmd" : "Ctrl"}+Shift+Y` })}
            active={
              info ? draft.capture.selection_shortcut === view?.settings.capture?.selection_shortcut && !!info.selection_shortcut_active : undefined
            }
          />
        </Row>
        <Row label={t("set.capture.target")} description={t("set.capture.targetDesc")}>
          <Select
            value={draft.capture.default_target}
            onChange={(e) => update({ capture: { ...draft.capture, default_target: e.target.value as Settings["capture"]["default_target"] } })}
            aria-label={t("set.capture.targetLabel")}
          >
            <option value="daily">{t("capture.daily")}</option>
            <option value="inbox">{t("capture.inbox")}</option>
            <option value="last">{t("set.capture.lastPage")}</option>
          </Select>
        </Row>
        <Row label={t("capture.inbox")} description={t("set.capture.inboxDesc")}>
          <CommitInput
            value={draft.capture.inbox_title}
            onCommit={(v) => update({ capture: { ...draft.capture, inbox_title: v.trim() || t("capture.inbox") } })}
            aria-label={t("set.capture.inboxTitle")}
          />
        </Row>
        <Row label={t("set.capture.meeting")} description={t("set.capture.meetingDesc")}>
          <Switch
            label={t("set.capture.meeting")}
            checked={draft.capture.meeting_target}
            onChange={(v) => update({ capture: { ...draft.capture, meeting_target: v } })}
          />
        </Row>
        <Row
          label={t("set.capture.hide")}
          description={info?.capture_open_ms ? `${t("set.capture.hideDesc")} ${t("set.capture.openedIn", { ms: info.capture_open_ms })}` : t("set.capture.hideDesc")}
        >
          <Select
            value={String(draft.capture.auto_hide_ms)}
            onChange={(e) => update({ capture: { ...draft.capture, auto_hide_ms: Number(e.target.value) } })}
            aria-label={t("set.capture.hide")}
          >
            {[...new Set([0, 800, 1200, 2000, 4000, draft.capture.auto_hide_ms])]
              .sort((a, b) => a - b)
              .map((ms) => (
                <option key={ms} value={String(ms)}>
                  {ms === 0 ? t("set.capture.hideNow") : `${decimal(ms / 1000)} s`}
                </option>
              ))}
          </Select>
        </Row>
      </Group>
    </>
  );
}

/** Offers to restart now; the move (or switch) happens at the next start either way. */
async function offerRestart(dir: string, what: string) {
  const s = useApp.getState();
  const restart = await s.confirm({
    title: t("set.data.restartNeeded"),
    message: `${what} ${t("set.data.restartMeanwhile")}`,
    confirmLabel: t("common.restartNow"),
    cancelLabel: t("common.later"),
  });
  if (restart) return restartApp();
  s.toast({
    tone: "info",
    persistent: true,
    title: t("set.data.restartPending"),
    detail: t("set.data.restartPendingText", { dir }),
    action: { label: t("common.restartNow"), run: () => void restartApp() },
  });
}

async function restartApp() {
  try {
    await flushAllEditors();
    await api.restart();
  } catch (e) {
    useApp.getState().error(t("set.data.restartFailed"), e);
  }
}

async function moveDataDir(onChanged: () => void) {
  const s = useApp.getState();
  const dir = await pickFolder(t("set.data.pick"));
  if (!dir) return;
  try {
    const target = await api.inspectDataDir(dir);
    let useExisting = false;
    if (target.has_workspace) {
      useExisting = await s.confirm({
        title: t("set.data.useExistingAsk"),
        message: t("set.data.useExistingText", { dir }),
        confirmLabel: t("set.data.useExisting"),
      });
      if (!useExisting) return;
    }
    await api.setDataDir(dir, useExisting);
    onChanged();
    const warn = target.synced ? ` ${t("set.data.syncedWarning")}` : "";
    await offerRestart(dir, (useExisting ? t("set.data.opensThere", { dir }) : t("set.data.copiesThere", { dir })) + warn);
  } catch (e) {
    s.error(t("set.data.moveFailed"), e);
  }
}

function UpdatesGroup({ draft, update }: { draft: Settings; update: (p: Partial<Settings>) => void }) {
  const t = useT();
  const { status, available, phase, checkedAt } = useUpdates();
  useEffect(() => void loadUpdateStatus(), []);
  if (!status) return null;
  const busy = phase === "preparing" || phase === "downloading" || phase === "installing";
  let state: React.ReactNode;
  let tone: "neutral" | "success" | "info" | "busy" = "neutral";
  if (!status.enabled) state = t(NOT_CONFIGURED) + ".";
  else if (available) (state = t("upd.available", { version: available.version })), (tone = "info");
  else if (phase === "checking") (state = t("upd.checking")), (tone = "busy");
  else if (checkedAt) (state = t("upd.current", { when: relative(checkedAt.toISOString()) })), (tone = "success");
  else state = t("upd.notChecked");
  return (
    <Group
      title={t("set.about.updates")}
      description={status.package && !status.portable ? t("upd.packageDesc") : status.portable ? t("upd.portableDesc") : t("upd.desc")}
    >
      {/* Status and actions: the buttons wrap below the text as soon as they do not fit beside it. */}
      <Row stack label={t("upd.status")} description={<StatusNote tone={tone} className="update-state">{state}</StatusNote>}>
        <div className="set-actions">
          {available && status.enabled && (
            <>
              <Button variant="ghost" onClick={() => useUpdates.setState({ notesOpen: true })}>
                {t("upd.whatsNew")}
              </Button>
              <UpdateAction />
            </>
          )}
          <Button
            variant={available ? "ghost" : "secondary"}
            icon={RefreshCw}
            disabled={!status.enabled || busy}
            loading={phase === "checking"}
            title={status.enabled ? undefined : t(NOT_CONFIGURED)}
            onClick={() => void checkForUpdates(true)}
          >
            {t("upd.checkNow")}
          </Button>
        </div>
      </Row>
      {status.enabled && (
        <Row label={t("upd.auto")} description={t("upd.autoDesc")}>
          <Switch label={t("upd.auto")} checked={draft.auto_update_check} onChange={(v) => update({ auto_update_check: v })} />
        </Row>
      )}
    </Group>
  );
}

function AboutSection({ draft, update, onOpenLog }: { draft: Settings; update: (p: Partial<Settings>) => void; onOpenLog: () => void }) {
  const t = useT();
  const view = useApp((s) => s.settings)!;
  const version = useUpdates((s) => s.status?.current_version) ?? view.version;
  const [status, setStatus] = useState<DataDirStatus | null>(null);
  const loadStatus = () => void api.dataDirStatus().then(setStatus, () => setStatus(null));
  useEffect(loadStatus, []);
  const global = (spec: string | null | undefined, label: string): [string, string][] => (spec?.trim() ? [[formatShortcut(spec, IS_MAC, " "), label]] : []);
  const keymap = effectiveKeymap(view.settings.keymap);
  const shortcuts: [string, string][] = [
    ...COMMANDS.filter((c) => keymap[c.id]).map((c): [string, string] => [comboLabel(keymap[c.id]), t(c.label)]),
    ...global(view.settings.palette_shortcut, t("keys.globalPalette")),
    ...global(view.settings.capture_shortcut, t("keys.globalCapture")),
    ...global(view.settings.search_shortcut, t("keys.globalSearch")),
    ...global(view.settings.capture?.selection_shortcut, t("keys.globalSelection")),
    ...global(view.settings.mail?.shortcut, t("keys.globalMail")),
  ];
  return (
    <>
      <header className="settings-head about-head">
        <span className="about-mark">
          <AnnaloLogo size={34} />
        </span>
        <div>
          <h1>Annalo</h1>
          <p>{t("upd.version", { version })}</p>
        </div>
      </header>
      <UpdatesGroup draft={draft} update={update} />
      <Group title={t("set.about.data")}>
        {status?.portable && (
          <Row
            stack
            label={t("set.about.portable")}
            description={t("set.about.portableDesc")}
          >
            <span className="portable-badge">
              <Badge tone="info">{t("set.about.portable")}</Badge>
            </span>
          </Row>
        )}
        <Row stack label={t("set.about.dataDir")} description={t("set.about.dataDirDesc")}>
          <PathValue value={view.data_dir} className="data-dir" />
        </Row>
        {status?.pending_move && (
          <Row stack label={t("set.data.nextStart")} description={t("set.data.nextStartDesc")}>
            <PathValue value={status.pending_move} />
            <div className="set-actions">
              <Button onClick={() => void restartApp()}>{t("common.restartNow")}</Button>
              <Button
                variant="ghost"
                onClick={async () => {
                  try {
                    setStatus(await api.cancelDataDirMove());
                  } catch (e) {
                    useApp.getState().error(t("set.data.discardFailed"), e);
                  }
                }}
              >
                {t("common.discard")}
              </Button>
            </div>
          </Row>
        )}
        <Row
          label={t("set.about.moveData")}
          description={
            status?.portable
              ? t("set.data.movePortable")
              : t("set.data.moveDesc")
          }
        >
          <Button icon={FolderInput} onClick={() => moveDataDir(loadStatus)} disabled={!!status?.portable}>
            {t("set.data.moveButton")}
          </Button>
        </Row>
        <DevLogAboutRow onOpen={onOpenLog} />
      </Group>
      <Group title={t("fr.about.group")}>
        <Row
          label={t("fr.about.rerun")}
          description={view.settings.onboarding?.completed_at ? t("fr.about.rerunDescAt", { date: fmtDate(view.settings.onboarding.completed_at) }) : t("fr.about.rerunDesc")}
        >
          <Button variant="ghost" icon={Compass} onClick={() => startFirstRun("rerun")} className="fr-rerun">
            {t("fr.about.rerunButton")}
          </Button>
        </Row>
        <Row label={t("fr.about.reset")} description={t("fr.about.resetDesc")}>
          <Button variant="ghost" onClick={() => void resetOnboarding()} className="fr-reset">
            {t("fr.about.resetButton")}
          </Button>
        </Row>
      </Group>
      <Group title={t("set.about.shortcuts")}>
        <div className="shortcut-list">
          {shortcuts.map(([k, d]) => (
            <div key={`${k}-${d}`} className="shortcut">
              <span>{d}</span>
              <span className="keys">
                {k.split(" ").map((x) => (
                  <kbd key={x}>{x}</kbd>
                ))}
              </span>
            </div>
          ))}
        </div>
      </Group>
    </>
  );
}
