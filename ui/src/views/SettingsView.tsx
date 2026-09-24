// Settings: grouped sections with a search over all rows. The connection sections (KI,
// Netzwerk, Sicherung, Desktop) and the preferences (Darstellung, Editor, Notizen, Zeit,
// Benachrichtigungen, Datenschutz, Start, Sprache, Tastatur) plus Verwaltung and Über.

import { AnnaloLogo } from "../components/Logo";
import { useEffect, useMemo, useRef, useState, useLayoutEffect } from "react";
import { Bell, CheckCircle2, DatabaseBackup, Download, ExternalLink, Globe, Monitor, Eye, EyeOff, FolderInput, FolderOpen, FolderOutput, Keyboard, KeyRound, Languages, Loader2, Palette, PenLine, PlugZap, Plus, Power, RefreshCw, Search, Server, Shield, SlidersHorizontal, Sparkles, Timer, Trash2, NotebookPen, Info, Upload, X, XCircle } from "lucide-react";
import { api, on } from "../lib/api";
import { collapsePages, foldersBelow } from "../lib/collapsed";
import { useApp } from "../store/app";
import { applyTheme, exportVault, importVault, pickFolder } from "../lib/actions";
import { flushAllEditors } from "../editor/NoteEditor";
import { fileSize, importSummary, relative, weekdayLabels } from "../lib/format";
import { Badge, Button, Field, IconButton, Input, Select, Switch, TextArea } from "../components/ui";
import { formatShortcut, keys, recordShortcut } from "../lib/shortcut";
import { IS_MAC } from "../lib/platform";
import { NOT_CONFIGURED } from "../lib/updates";
import { checkForUpdates, installUpdate, loadUpdateStatus, useUpdates } from "../components/Updates";
import { useT, type TKey } from "../lib/i18n";
import { COMMANDS, comboLabel, effectiveKeymap } from "../lib/keymap";
import type { BackupInfo, MirrorStatus, ConnectionTest, DataDirStatus, DesktopInfo, GitSyncMode, GitSyncSettings, GitSyncStatus, GitTest, Page, Settings } from "../lib/types";
import { CommitInput, FilterContext, Group, NumberInput, Row } from "./settings/common";
import { AppearanceSection } from "./settings/AppearanceSection";
import { EditorSection } from "./settings/EditorSection";
import { LocaleSection, NotesPrefGroups, NotificationsSection, PrivacySection, StartSection, TimePrefGroups } from "./settings/PrefSections";
import { AiPrefGroups } from "./settings/AiPrefGroups";
import { KeyboardSection } from "./settings/KeyboardSection";
import { NetworkSection, withPacResults } from "./settings/NetworkSection";
import { AdminSection } from "./settings/AdminSection";

type Section = "appearance" | "locale" | "start" | "keyboard" | "editor" | "notes" | "time" | "ai" | "privacy" | "network" | "notifications" | "backup" | "desktop" | "admin" | "about";
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
      { id: "about", label: "nav.about", icon: Info },
    ],
  },
];
/** Sections that save every change immediately (no save bar). */
const INSTANT = new Set<Section>(["appearance", "locale", "backup", "about"]);

export function SettingsView() {
  const t = useT();
  const view = useApp((s) => s.settings);
  const [section, setSection] = useState<Section>("ai");
  const [draft, setDraft] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState("");
  const s = useApp.getState;

  useEffect(() => {
    if (!view) s().refreshSettings();
    else setDraft(structuredClone(view.settings));
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
    void save(next);
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
      case "about":
        return <AboutSection draft={draft} update={u} />;
    }
  };

  const searching = query.trim().length > 0;
  const all = NAV.flatMap((g) => g.items).filter((x) => x.id !== "about" && x.id !== "admin");
  return (
    <div className="settings">
      <nav className="settings-nav" aria-label={t("settings.title")}>
        <div className="settings-nav-title">{t("settings.title")}</div>
        <div className="settings-search">
          <Search size={13} className="faint" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("settings.search")} aria-label={t("settings.search")} spellCheck={false} onKeyDown={(e) => e.key === "Escape" && setQuery("")} />
          {searching && <IconButton icon={X} label={t("common.clear")} size={20} iconSize={12} onClick={() => setQuery("")} />}
        </div>
        {NAV.map((g) => (
          <div key={g.label} className="settings-nav-group" role="group" aria-label={t(g.label)}>
            <div className="settings-nav-group-label">{t(g.label)}</div>
            {g.items.map((x) => (
              <button
                key={x.id}
                type="button"
                data-section={x.id}
                className={`settings-nav-item ${!searching && section === x.id ? "active" : ""}`}
                onClick={() => {
                  setQuery("");
                  setSection(x.id);
                }}
              >
                <x.icon size={15} strokeWidth={1.75} />
                {t(x.label)}
              </button>
            ))}
          </div>
        ))}
      </nav>
      <div className="settings-scroll">
        <div className="settings-body">
          {searching ? (
            <FilterContext.Provider value={query}>
              {all.map((x) => (
                <SearchSection key={x.id} title={t(x.label)} onOpen={() => (setQuery(""), setSection(x.id))}>
                  {render(x.id)}
                </SearchSection>
              ))}
              <p className="faint small settings-search-empty">{t("settings.noHits", { query })}</p>
            </FilterContext.Provider>
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
function SearchSection({ title, onOpen, children }: { title: string; onOpen: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [empty, setEmpty] = useState(false);
  useLayoutEffect(() => {
    setEmpty(!ref.current?.querySelector(".set-group:not([hidden]) .set-row"));
  });
  return (
    <div className="settings-hit-section" hidden={empty} ref={ref}>
      <button type="button" className="settings-hit-title" onClick={onOpen}>
        {title}
      </button>
      <div className="settings-hit-body">{children}</div>
    </div>
  );
}

// -------------------------------------------------------------------- AI

function AiSection({ draft, update }: { draft: Settings; update: (p: Partial<Settings>) => void }) {
  const t = useT();
  const view = useApp((s) => s.settings)!;
  const [key, setKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [test, setTest] = useState<ConnectionTest | null>(null);
  const [testing, setTesting] = useState(false);
  const s = useApp.getState;
  const models = test?.ok ? test.models : [];

  const runTest = async () => {
    setTesting(true);
    try {
      setTest(await api.testConnection(draft.litellm_base_url, key || null));
    } catch (e) {
      setTest({ ok: false, latency_ms: 0, models: [], error: String(e) });
    } finally {
      setTesting(false);
    }
  };
  useEffect(() => {
    runTest();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveKey = async (value: string | null) => {
    try {
      const v = await api.setApiKey(value);
      s().set({ settings: v });
      setKey("");
      s().toast({ tone: "success", title: value ? "API-Token gespeichert" : "API-Token entfernt", detail: v.api_key_storage });
      runTest();
    } catch (e) {
      s().error("Token konnte nicht gespeichert werden", e);
    }
  };

  const router = draft.router;
  const setRouter = (p: Partial<Settings["router"]>) => update({ router: { ...router, ...p } });

  return (
    <>
      <header className="settings-head">
        <h1>{t("set.ai.title")}</h1>
        <p>Annalo spricht mit deinem LiteLLM-Server. Lokale Modelle (Ollama, vLLM) und Cloud-Modelle werden dort konfiguriert.</p>
      </header>

      <Group title={t("set.ai.server")} description="Adresse deines LiteLLM-Proxys und der Zugangstoken (Virtual Key oder Master Key).">
        <Row stack label={t("set.ai.serverUrl")} description="z. B. https://llm.firma.de oder http://localhost:4000">
          <Input value={draft.litellm_base_url} onChange={(e) => update({ litellm_base_url: e.target.value })} placeholder="https://" aria-label="Server-URL" className="grow" />
        </Row>
        <Row
          stack
          label={t("set.ai.apiToken")}
          description={
            <>
              {view.api_key_set ? <Badge tone="success">Hinterlegt</Badge> : <Badge>Nicht gesetzt</Badge>}
              <span>Sicher gespeichert in: {view.api_key_storage}</span>
            </>
          }
        >
          <div className="key-input">
            <KeyRound size={14} className="faint" />
            <input
              type={showKey ? "text" : "password"}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={view.api_key_set ? "Neuen Token eingeben, um ihn zu ersetzen" : "sk-…"}
              aria-label="API-Token"
              autoComplete="off"
              spellCheck={false}
              onKeyDown={(e) => e.key === "Enter" && key.trim() && saveKey(key.trim())}
            />
            <IconButton icon={showKey ? EyeOff : Eye} label={showKey ? "Verbergen" : "Anzeigen"} size={24} iconSize={14} onClick={() => setShowKey(!showKey)} />
          </div>
          <Button variant="primary" onClick={() => saveKey(key.trim())} disabled={!key.trim()}>
            Speichern
          </Button>
          {view.api_key_set && <IconButton icon={Trash2} label="Token entfernen" onClick={() => saveKey(null)} />}
        </Row>
        <Row label={t("set.ai.connection")} description="Fragt die verfügbaren Modelle beim Server ab.">
          <div className={`conn ${test ? (test.ok ? "ok" : "fail") : ""}`}>
            {testing ? (
              <>
                <Loader2 size={14} className="spin" /> Prüfe…
              </>
            ) : test?.ok ? (
              <>
                <CheckCircle2 size={14} /> Verbunden · {test.models.length} Modelle · {test.latency_ms} ms
              </>
            ) : test ? (
              <span title={test.error ?? ""}>
                <XCircle size={14} /> Keine Verbindung
              </span>
            ) : null}
          </div>
          <Button icon={RefreshCw} onClick={runTest} disabled={testing}>
            Testen
          </Button>
        </Row>
        {test && !test.ok && test.error && <p className="error-note mono small">{test.error}</p>}
      </Group>

      <Group title={t("set.ai.models")} description="Welche Modelle des Servers für welche Aufgaben verwendet werden.">
        <Row label={t("set.ai.autoRoute")} description="Einfache Aufgaben gehen an das lokale Modell, komplexe an stärkere Modelle.">
          <Switch checked={draft.auto_route} onChange={(v) => update({ auto_route: v })} label="Automatisches Routing" />
        </Row>
        <Row label={t("set.ai.local")} description="Für kurze Fragen, Umformulierungen und vertrauliche Inhalte.">
          <ModelInput value={router.local_model} models={models} onChange={(v) => setRouter({ local_model: v })} label="Lokales Modell" />
        </Row>
        <Row label={t("set.ai.standard")} description={draft.auto_route ? "Für die meisten Aufgaben." : "Wird für alle Anfragen verwendet."}>
          <ModelInput value={router.standard_model} models={models} onChange={(v) => setRouter({ standard_model: v })} label="Standardmodell" />
        </Row>
        <Row label={t("set.ai.reasoning")} description="Für Analysen, Planung und Code.">
          <ModelInput value={router.reasoning_model} models={models} onChange={(v) => setRouter({ reasoning_model: v })} label="Reasoning-Modell" />
        </Row>
        <Row label={t("set.ai.embeddings")} description="Für die semantische Suche in Notizen. Leer = nur Stichwortsuche.">
          <ModelInput value={draft.embedding_model ?? ""} models={models} onChange={(v) => update({ embedding_model: v || null })} label="Embedding-Modell" allowEmpty />
        </Row>
      </Group>

      <Group title={t("set.ai.behavior")}>
        <Field label={t("set.ai.instructions")} hint="z. B. Rolle, Tonalität, bevorzugte Formate">
          <TextArea rows={4} value={draft.assistant_instructions} onChange={(e) => update({ assistant_instructions: e.target.value })} placeholder="Ich bin SAP-Berater im Projekt … Antworte knapp." />
        </Field>
      </Group>
    </>
  );
}

function ModelInput({ value, models, onChange, label, allowEmpty }: { value: string; models: string[]; onChange: (v: string) => void; label: string; allowEmpty?: boolean }) {
  if (models.length) {
    const missing = value && !models.includes(value);
    return (
      <div className="model-input">
        <Select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} className="w-360">
          {allowEmpty && <option value="">Keines</option>}
          {!allowEmpty && !value && <option value="">Modell wählen</option>}
          {missing && <option value={value}>{value} (nicht auf dem Server)</option>}
          {models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </Select>
        {missing && <span className="warn-note small">Dieses Modell bietet der Server nicht an</span>}
      </div>
    );
  }
  return <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={allowEmpty ? "Keines" : "Modellname"} aria-label={label} className="w-360" />;
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
        <p>Leerlauferkennung, Budgetwarnungen und Angaben für SAP- und Jira-Exporte.</p>
      </header>
      <Group title={t("set.time.timer")}>
        <Row label={t("set.time.idle")} description="Pausen ohne Tastatur- oder Mauseingabe, die länger dauern, werden beim Stoppen zum Abziehen angeboten.">
          <div className="unit-input">
            <NumberInput min={1} max={120} value={draft.idle_threshold_minutes} onCommit={(v) => update({ idle_threshold_minutes: v })} aria-label="Minuten" />
            <span className="faint">Minuten</span>
          </div>
        </Row>
      </Group>
      <Group title={t("set.time.workTime")} description="Tage unter dem Soll werden in der Wochenübersicht markiert.">
        <Row label={t("set.time.target")}>
          <div className="unit-input">
            <NumberInput min={0.5} max={16} step={0.25} value={draft.daily_target_hours} onCommit={(v) => update({ daily_target_hours: v })} aria-label="Stunden" />
            <span className="faint">Stunden</span>
          </div>
        </Row>
        <Row label={t("set.time.workdays")}>
          <div className="day-toggle" role="group" aria-label="Arbeitstage">
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
      <Group title={t("set.time.budget")} description="Gilt für Netzpläne und Vorgänge.">
        <Row label={t("set.time.warnAt")}>
          <div className="unit-input">
            <NumberInput min={1} max={100} value={pct(draft.thresholds.warning)} onCommit={(v) => update({ thresholds: { ...draft.thresholds, warning: v / 100 } })} aria-label="Warnung in Prozent" />
            <span className="faint">% verbraucht</span>
          </div>
        </Row>
        <Row label={t("set.time.criticalAt")} description="Oder wenn die Prognose (gebucht + Restaufwand) den Plan übersteigt.">
          <div className="unit-input">
            <NumberInput min={1} max={100} value={pct(draft.thresholds.critical)} onCommit={(v) => update({ thresholds: { ...draft.thresholds, critical: v / 100 } })} aria-label="Kritisch in Prozent" />
            <span className="faint">% verbraucht</span>
          </div>
        </Row>
        {pct(draft.thresholds.warning) >= pct(draft.thresholds.critical) && (
          <p className="error-note small" role="alert">Die Warnschwelle muss unter der kritischen Schwelle liegen.</p>
        )}
      </Group>
      <Group title="SAP CATS">
        <Row label={t("set.time.pernr")}>
          <Input value={draft.pernr ?? ""} onChange={(e) => update({ pernr: e.target.value || null })} placeholder="00012345" aria-label="Personalnummer" />
        </Row>
      </Group>
      <Group title={t("set.time.jira")} description="Netzplan oder Netzplan/Vorgang zu Jira-Issue. Die spezifischere Zuordnung gewinnt.">
        <div className="map-list">
          {Object.entries(draft.jira_issue_map).map(([k, v]) => (
            <div key={k} className="map-row">
              <span className="mono">{k}</span>
              <span className="faint">→</span>
              <span className="mono">{v}</span>
              <span className="grow" />
              <IconButton
                icon={Trash2}
                label="Entfernen"
                size={24}
                iconSize={13}
                onClick={() => {
                  const m = { ...draft.jira_issue_map };
                  delete m[k];
                  update({ jira_issue_map: m });
                }}
              />
            </div>
          ))}
          <div className="map-row">
            <Input value={mapKey} onChange={(e) => setMapKey(e.target.value)} placeholder="NP-8801/1020" className="mono" aria-label="Netzplan/Vorgang" />
            <span className="faint">→</span>
            <Input value={mapVal} onChange={(e) => setMapVal(e.target.value)} placeholder="AET-12" className="mono" aria-label="Jira-Issue" />
            <Button
              icon={Plus}
              disabled={!mapKey.trim() || !mapVal.trim()}
              onClick={() => {
                update({ jira_issue_map: { ...draft.jira_issue_map, [mapKey.trim()]: mapVal.trim() } });
                setMapKey("");
                setMapVal("");
              }}
            >
              Hinzufügen
            </Button>
          </div>
        </div>
      </Group>
      <Group title={t("set.time.leistungsarten")} description="Werden direkt gespeichert.">
        <div className="map-list">
          {las.map(([code, desc]) => (
            <div key={code} className="map-row">
              <Badge>{code}</Badge>
              <span>{desc}</span>
              <span className="grow" />
              <IconButton
                icon={Trash2}
                label="Löschen"
                size={24}
                iconSize={13}
                onClick={async () => {
                  try {
                    await api.deleteLeistungsart(code);
                    reload();
                    s().bumpWbs();
                  } catch (e) {
                    s().error("Löschen nicht möglich", e);
                  }
                }}
              />
            </div>
          ))}
          <div className="map-row">
            <Input value={newLa.code} onChange={(e) => setNewLa({ ...newLa, code: e.target.value.toUpperCase() })} placeholder="CODE" className="mono w-120" aria-label="Code" />
            <Input value={newLa.desc} onChange={(e) => setNewLa({ ...newLa, desc: e.target.value })} placeholder="Beschreibung" aria-label="Beschreibung" />
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
                  s().error("Speichern nicht möglich", e);
                }
              }}
            >
              Hinzufügen
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
        <p>Alle Notizen sind Markdown und liegen lokal. Du kannst jederzeit aus Obsidian importieren oder alles als Markdown-Ordner exportieren.</p>
      </header>
      <Group title={t("set.notes.templates")}>
        <Row label={t("set.notes.dailyTemplate")} description="Gilt für neu angelegte Tagesnotizen. Vorlagen sind die Seiten unter „Vorlagen“.">
          <Select
            value={draft.daily_template == null ? "" : String(draft.daily_template)}
            onChange={(e) => update({ daily_template: e.target.value ? Number(e.target.value) : null })}
            aria-label="Vorlage für Tagesnotizen"
            className="w-360"
          >
            <option value="">Standard (Fokus und Notizen)</option>
            {missing && templates.length > 0 && <option value={String(draft.daily_template)}>Gelöschte Vorlage</option>}
            {templates.map((t) => (
              <option key={t.id} value={String(t.id)}>
                {t.title}
              </option>
            ))}
          </Select>
        </Row>
      </Group>
      <Group title="Obsidian" description="Ordner werden zu Seiten, [[Links]] und #Tags bleiben erhalten. Bilder werden als Anhänge übernommen, andere Dateien übersprungen.">
        <Row label={t("set.notes.importVault")}>
          <Button icon={FolderInput} onClick={() => importVault()}>
            Ordner wählen…
          </Button>
        </Row>
        <Row stack label={t("set.notes.path")} description="Alternativ zum Dialog.">
          <Input value={path} onChange={(e) => setPath(e.target.value)} placeholder="C:\\Users\\du\\Obsidian\\Vault" className="grow" aria-label="Vault-Pfad" />
          <Button onClick={() => path.trim() && importVault(path.trim())} disabled={!path.trim()}>
            Importieren
          </Button>
        </Row>
        <Row label={t("set.notes.exportMd")} description="Schreibt jede Seite als .md-Datei, Unterseiten als Ordner.">
          <Button icon={FolderOutput} onClick={() => exportVault()}>
            Zielordner wählen…
          </Button>
        </Row>
      </Group>
      <Group title={t("set.notes.samples")}>
        <Row label={t("set.notes.removeSamples")} description="Löscht das Beispielprojekt PRJ-2026-X mit seinen Zeiten und die Beispielseiten. Deine eigenen Seiten und Tagesnotizen bleiben erhalten.">
          <Button
            variant="danger"
            icon={Trash2}
            onClick={async () => {
              const s = useApp.getState();
              if (!(await s.confirm({ title: "Beispieldaten entfernen?", message: "Das Beispielprojekt, seine Zeitbuchungen und die Beispielseiten werden gelöscht.", confirmLabel: "Entfernen", danger: true }))) return;
              try {
                const n = await api.removeDemo();
                await s.refreshTree();
                s.bumpWbs();
                s.bumpEntries();
                s.toast({ tone: "success", title: "Beispieldaten entfernt", detail: n ? "Beispielprojekt und -seiten gelöscht" : "Beispielprojekt gelöscht" });
              } catch (e) {
                s.error("Entfernen fehlgeschlagen", e);
              }
            }}
          >
            Entfernen
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
    const dir = await pickFolder("Ordner für die Markdown-Kopie (leer oder eine frühere Kopie)");
    if (dir) update({ markdown_mirror_dir: dir });
  };
  const openMirror = async () => {
    try {
      await api.openMirror();
    } catch (e) {
      s().error("Ordner konnte nicht geöffnet werden", e);
    }
  };

  const pick = async () => {
    const dir = await pickFolder("Ordner für Sicherungen");
    if (dir) update({ backup_dir: dir });
  };
  const backupNow = async () => {
    setBusy(true);
    try {
      const b = await api.backupNow();
      s().toast({ tone: "success", title: "Sicherung erstellt", detail: `${b.file_name} · ${fileSize(b.size_bytes)}` });
      reload();
    } catch (e) {
      s().error("Sicherung fehlgeschlagen", e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <header className="settings-head">
        <h1>{t("set.backup.title")}</h1>
        <p>Die Datenbank wird einmal täglich automatisch gesichert. Eine Sicherung ist eine vollständige Kopie von workspace.db. Zum Wiederherstellen die Datei bei geschlossener App in den Datenordner kopieren und in workspace.db umbenennen.</p>
      </header>
      <Group title={t("set.backup.auto")} description="Wird beim Start und danach stündlich geprüft; gesichert wird, wenn die letzte Sicherung älter als 24 Stunden ist.">
        <Row
          label="Ordner"
          description={
            <>
              <span>{draft.backup_dir ? "Eigener Ordner, z. B. ein Netzlaufwerk:" : "Standard, im Datenordner:"}</span>
              <span className="mono selectable backup-path">{view.backup_dir}</span>
            </>
          }
        >
          <Button icon={FolderOpen} onClick={pick}>
            Ordner wählen…
          </Button>
          {draft.backup_dir && (
            <Button variant="ghost" onClick={() => update({ backup_dir: null })}>
              Standard
            </Button>
          )}
        </Row>
        <Row label={t("set.backup.keep")} description="Ältere Sicherungen werden gelöscht.">
          <div className="unit-input">
            <NumberInput min={1} max={365} value={draft.backup_keep} onCommit={(v) => update({ backup_keep: v })} aria-label="Anzahl Sicherungen" />
            <span className="faint">Sicherungen</span>
          </div>
        </Row>
      </Group>
      <Group
        title="Markdown-Kopie"
        description="Nach jeder Sicherung werden alle Seiten als Markdown-Dateien (mit Bildern) und die Buchungen als Zeiterfassung/JJJJ-MM.csv in einen Ordner geschrieben – lesbar auch ohne Annalo. Der Ordner wird jedes Mal vollständig ersetzt."
      >
        <Row label={t("set.backup.mirror")}>
          <Switch label="Markdown-Kopie bei jeder Sicherung" checked={draft.markdown_mirror} onChange={(v) => update({ markdown_mirror: v })} />
        </Row>
        {draft.markdown_mirror && (
          <>
            <Row
              label="Ordner"
              description={
                <>
                  <span>{draft.markdown_mirror_dir ? "Eigener Ordner (leer oder eine frühere Kopie):" : "Standard, im Sicherungsordner:"}</span>
                  <span className="mono selectable backup-path mirror-path">{mirror?.path ?? ""}</span>
                </>
              }
            >
              <Button icon={FolderOpen} onClick={pickMirror}>
                Ordner wählen…
              </Button>
              {draft.markdown_mirror_dir && (
                <Button variant="ghost" onClick={() => update({ markdown_mirror_dir: null })}>
                  Standard
                </Button>
              )}
            </Row>
            <Row
              label="Letzte Kopie"
              description={
                mirror?.error ? (
                  <span className="mirror-error">Fehlgeschlagen: {mirror.error}</span>
                ) : mirror?.last_at ? (
                  <span className="mirror-last">
                    {new Date(mirror.last_at).toLocaleString("de-DE", { dateStyle: "medium", timeStyle: "short" })} · {relative(mirror.last_at)}
                  </span>
                ) : (
                  "Noch keine – wird mit der nächsten Sicherung erstellt."
                )
              }
            >
              <Button icon={ExternalLink} onClick={openMirror} disabled={!mirror?.last_at}>
                Ordner öffnen
              </Button>
            </Row>
          </>
        )}
      </Group>
      <Group title={t("set.backup.backups")}>
        <Row label={t("set.backup.now")} description="Legt sofort eine zusätzliche Sicherung an.">
          <Button icon={DatabaseBackup} onClick={backupNow} loading={busy}>
            Jetzt sichern
          </Button>
        </Row>
        <div className="backup-list" aria-label="Vorhandene Sicherungen">
          {list?.length === 0 && <p className="faint small">Noch keine Sicherung vorhanden.</p>}
          {list?.map((b) => (
            <div key={b.path} className="backup-row" title={b.path}>
              <span className="grow">{new Date(b.created_at).toLocaleString("de-DE", { dateStyle: "medium", timeStyle: "short" })}</span>
              <span className="faint small">{relative(b.created_at)}</span>
              <span className="faint small num">{fileSize(b.size_bytes)}</span>
            </div>
          ))}
        </div>
      </Group>
      <GitSyncGroup draft={draft} update={update} dbSize={list?.[0]?.size_bytes ?? null} onSynced={reload} />
    </>
  );
}

const BIG_DB = 50 * 1024 * 1024;

function GitSyncGroup({ draft, update, dbSize, onSynced }: { draft: Settings; update: (p: Partial<Settings>) => void; dbSize: number | null; onSynced: () => void }) {
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
      s().toast({ tone: "success", title: value ? "Git-Token gespeichert" : "Git-Token entfernt" });
    } catch (e) {
      s().error("Token konnte nicht gespeichert werden", e);
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
  const syncNow = async () => {
    setSyncing(true);
    try {
      const r = await api.gitSyncNow();
      s().toast({ tone: r.fallback ? "warning" : "success", title: r.committed ? "Synchronisiert" : "Git ist aktuell", detail: r.fallback ? r.message : `${r.message}${r.commit ? ` · ${r.commit}` : ""}` });
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
      s().toast({ tone: "success", title: "Aus Git importiert", detail: importSummary(r) });
      setRestoreUrl(null);
    } catch (e) {
      s().error("Wiederherstellen fehlgeschlagen", e);
    } finally {
      setRestoring(false);
    }
  };

  const fallback = status?.last_branch && status.last_branch !== git.branch ? status.last_branch : null;
  return (
    <Group
      title="Git-Synchronisierung"
      description="Überträgt die Markdown-Kopie (und optional die Datenbank) als Commit in ein Git-Repository, z. B. auf GitHub, GitLab oder Azure DevOps. Benötigt ein installiertes Git (git-scm.com)."
    >
      <Row label="Git-Synchronisierung" description={git.remote_url ? undefined : "Zuerst die Remote-URL eintragen."}>
        <Switch label="Git-Synchronisierung" checked={git.enabled} onChange={(v) => setGit({ enabled: v })} />
      </Row>
      <Row stack label="Remote-URL" description="HTTPS mit Zugangstoken, oder SSH (git@…): SSH-URLs verwenden die SSH-Schlüssel bzw. den SSH-Agent des Systems.">
        <CommitInput value={git.remote_url} onCommit={(v) => setGit({ remote_url: v })} placeholder="https://github.com/name/notizen.git" aria-label="Remote-URL" className="grow" />
      </Row>
      <Row label="Branch">
        <CommitInput value={git.branch} onCommit={(v) => setGit({ branch: v || "main" })} placeholder="main" aria-label="Branch" />
      </Row>
      <Row label="Autor" description="Name und E-Mail der Commits.">
        <CommitInput value={git.author_name} onCommit={(v) => setGit({ author_name: v })} placeholder="Name" aria-label="Autor Name" />
        <CommitInput value={git.author_email} onCommit={(v) => setGit({ author_email: v })} placeholder="E-Mail" aria-label="Autor E-Mail" />
      </Row>
      <Row
        stack
        label="Zugangstoken"
        description={
          <>
            {status?.token_set ? <Badge tone="success">gespeichert</Badge> : <Badge>Nicht gesetzt</Badge>}
            <span>Personal Access Token (nur für HTTPS). Sicher gespeichert, nie in Dateien oder im Repository.</span>
          </>
        }
      >
        <div className="key-input">
          <KeyRound size={14} className="faint" />
          <input
            type={showToken ? "text" : "password"}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={status?.token_set ? "Neuen Token eingeben, um ihn zu ersetzen" : "ghp_… / glpat-…"}
            aria-label="Git-Zugangstoken"
            autoComplete="off"
            spellCheck={false}
            onKeyDown={(e) => e.key === "Enter" && token.trim() && saveToken(token.trim())}
          />
          <IconButton icon={showToken ? EyeOff : Eye} label={showToken ? "Verbergen" : "Anzeigen"} size={24} iconSize={14} onClick={() => setShowToken(!showToken)} />
        </div>
        <Button variant="primary" onClick={() => saveToken(token.trim())} disabled={!token.trim()}>
          Speichern
        </Button>
        {status?.token_set && <IconButton icon={Trash2} label="Git-Token entfernen" onClick={() => saveToken(null)} />}
      </Row>
      <Row label="Zeitpunkt">
        <Select value={git.mode} onChange={(e) => setGit({ mode: e.target.value as GitSyncMode })} aria-label="Zeitpunkt der Synchronisierung">
          <option value="with_backup">Mit jeder Sicherung</option>
          <option value="hourly">Stündlich</option>
        </Select>
      </Row>
      <Row
        label="Datenbank mitsichern"
        description={
          git.include_database ? (
            <span className={dbSize != null && dbSize > BIG_DB ? "mirror-error" : ""}>
              Die letzte Sicherung wird als annalo-workspace.db übertragen{dbSize != null ? ` (derzeit ${fileSize(dbSize)})` : ""}. Jede Änderung speichert die ganze Datei neu – das Repository wächst schnell; GitHub lehnt Dateien über 100 MB ab.
            </span>
          ) : (
            "Nur Markdown, Bilder und Zeiterfassung (empfohlen)."
          )
        }
      >
        <Switch label="Datenbank mitsichern" checked={git.include_database} onChange={(v) => setGit({ include_database: v })} />
      </Row>
      <Row label="Verbindung" description="Prüft URL und Zugangsdaten (git ls-remote).">
        <div className={`conn ${test ? (test.ok ? "ok" : "fail") : ""}`}>
          {testing ? (
            <>
              <Loader2 size={14} className="spin" /> Prüfe…
            </>
          ) : test?.ok ? (
            <span className="git-test-ok">
              <CheckCircle2 size={14} /> Verbunden · {test.branches.length} Branches · {test.latency_ms} ms
            </span>
          ) : test ? (
            <span title={test.error ?? ""}>
              <XCircle size={14} /> Keine Verbindung
            </span>
          ) : null}
        </div>
        <Button icon={PlugZap} onClick={runTest} disabled={testing || !git.remote_url}>
          Verbindung testen
        </Button>
      </Row>
      {test && !test.ok && test.error && <p className="error-note mono small">{test.error}</p>}
      <Row
        label="Letzte Synchronisierung"
        description={
          <span className="git-status">
            {status?.last_error ? (
              <span className="mirror-error">Fehlgeschlagen: {status.last_error}</span>
            ) : status?.last_at ? (
              <span>
                {relative(status.last_at)}
                {status.last_commit ? ` · Commit ${status.last_commit}` : ""}
                {fallback ? ` · auf Branch ${fallback}` : ""}
              </span>
            ) : (
              <span>Noch nie</span>
            )}
            {status && status.pending_changes > 0 && <span className="faint"> · {status.pending_changes} Dateien ausstehend</span>}
          </span>
        }
      >
        <Button icon={Upload} onClick={syncNow} loading={syncing} disabled={!git.remote_url}>
          Jetzt synchronisieren
        </Button>
      </Row>
      <Row label="Wiederherstellen" description="Klont das Repository und importiert es als neue Seite „Git-Import <Datum>“. Bestehende Seiten bleiben unverändert.">
        <Button icon={Download} onClick={() => setRestoreUrl(restoreUrl == null ? git.remote_url : null)}>
          Aus Git wiederherstellen…
        </Button>
      </Row>
      {restoreUrl != null && (
        <Row stack label="Repository-URL" description="Der gespeicherte Token wird nur an die eingestellte Remote-URL gesendet.">
          <Input value={restoreUrl} onChange={(e) => setRestoreUrl(e.target.value)} onKeyDown={(e) => e.key === "Enter" && restore()} aria-label="Repository-URL zum Wiederherstellen" className="grow" autoFocus />
          <Button variant="primary" onClick={restore} loading={restoring} disabled={!restoreUrl.trim()}>
            Importieren
          </Button>
          <Button variant="ghost" onClick={() => setRestoreUrl(null)}>
            Abbrechen
          </Button>
        </Row>
      )}
    </Group>
  );
}

/** Wording of the window options: tray and login items are called differently on macOS. */
const desk = IS_MAC
  ? {
      closeLabel: "Beim Schließen im Dock/Menüleiste weiterlaufen",
      closeHint: "Schließen blendet das Fenster nur aus; Timer und Erinnerungen laufen weiter. Ein Klick auf das Dock-Symbol holt es zurück, ⌘Q beendet.",
      autostartLabel: "Bei der Anmeldung starten",
      autostartHint: "Startet bei der Anmeldung im Hintergrund (Symbol in der Menüleiste). Wird sofort übernommen.",
    }
  : {
      closeLabel: "In den Infobereich schließen",
      closeHint: "Schließen blendet das Fenster nur aus; Timer und Erinnerungen laufen weiter. Beenden über das Symbol im Infobereich.",
      autostartLabel: "Mit Windows starten",
      autostartHint: "Startet bei der Anmeldung minimiert im Infobereich. Wird sofort übernommen.",
    };

function DesktopSection({ draft, update }: { draft: Settings; update: (p: Partial<Settings>) => void }) {
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
      s().error("Autostart konnte nicht geändert werden", e);
    }
  };
  const reminderOn = draft.reminder_time != null;

  return (
    <>
      <header className="settings-head">
        <h1>Desktop</h1>
        <p>{IS_MAC ? "Symbol in der Menüleiste" : "Symbol im Infobereich"}, Autostart, Erinnerungen, Schnellsuche und Schnellerfassung.</p>
      </header>
      <Group title="Fenster">
        <Row
          label={desk.closeLabel}
          description={
            <>
              {desk.closeHint}
              {info && !info.tray && !IS_MAC && <Badge tone="warning">Kein Infobereich verfügbar – das Fenster wird minimiert</Badge>}
            </>
          }
        >
          <Switch label={desk.closeLabel} checked={draft.close_to_tray} onChange={(v) => update({ close_to_tray: v })} />
        </Row>
        <Row label={desk.autostartLabel} description={desk.autostartHint}>
          <Switch label={desk.autostartLabel} checked={!!info?.autostart} onChange={setAutostart} />
        </Row>
      </Group>
      <Group title="Befehlspalette">
        <Row
          label="Tastenkürzel (global)"
          description={`Holt Annalo mit der Befehlspalette nach vorn. Ins Feld klicken und die Tasten drücken, z. B. ${keys("Mod Shift K")}. Entf = aus. ${keys("Mod K")} funktioniert im Fenster immer.`}
        >
          <ShortcutField
            value={draft.palette_shortcut ?? ""}
            onChange={(v) => update({ palette_shortcut: v || null })}
            label="Tastenkürzel Befehlspalette"
            placeholder={`z. B. ${IS_MAC ? "Cmd" : "Ctrl"}+Shift+K`}
            active={info ? (draft.palette_shortcut ?? "") === (view?.settings.palette_shortcut ?? "") && info.palette_shortcut_active : undefined}
          />
        </Row>
      </Group>
      <Group title="Schnellsuche" description="Ein Suchfenster über allen Programmen: Seiten, Inhalte und Buchungen finden, Tagesnotiz öffnen, Timer starten oder „/zeit …“ buchen. Auch über „Suchen…“ im Infobereich.">
        <Row
          label="Tastenkürzel (global)"
          description="Ins Feld klicken und die Tasten drücken, z. B. Ctrl+Shift+O. Ctrl+Shift+F bleibt die Suche in der Seitenleiste. Entf = aus."
        >
          <ShortcutField
            value={draft.search_shortcut}
            onChange={(v) => update({ search_shortcut: v })}
            label="Tastenkürzel Schnellsuche"
            placeholder="Tasten drücken…"
            active={info ? draft.search_shortcut === view?.settings.search_shortcut && info.search_shortcut_active : undefined}
          />
        </Row>
      </Group>
      <Group title="Feierabend-Erinnerung" description="Hinweis an Arbeitstagen, wenn weniger als das Tagessoll gebucht ist. Ein Klick darauf öffnet die Zeiterfassung. Läuft nach 20 Uhr noch ein Timer, erinnert Annalo einmal daran.">
        <Row label="Erinnern um">
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
                aria-label="Uhrzeit der Erinnerung"
              />
            )}
            <span className="faint">{reminderOn ? "Uhr" : "Aus"}</span>
            <Switch label="Feierabend-Erinnerung" checked={reminderOn} onChange={(v) => update({ reminder_time: v ? "17:30" : null })} />
          </div>
        </Row>
      </Group>
      <Group title="Schnellerfassung" description="Ein kleines Fenster über allen anderen: Text landet in der heutigen Tagesnotiz, „todo …“ oder „- [ ] …“ als Aufgabe, „/zeit …“ wird gebucht.">
        <Row
          label="Tastenkürzel (global)"
          description={
            IS_MAC
              ? `Ins Feld klicken und die Tasten drücken, z. B. ${formatShortcut("Cmd+Shift+Space")}. ⌥ allein geht nicht – damit tippt man Zeichen wie @ oder €. Entf = aus.`
              : "Ins Feld klicken und die Tasten drücken, z. B. Ctrl+Shift+Space. Ctrl+Alt geht nicht – das ist AltGr auf deutschen Tastaturen. Entf = aus."
          }
        >
          <ShortcutField
            value={draft.capture_shortcut}
            onChange={(v) => update({ capture_shortcut: v })}
            label="Tastenkürzel Schnellerfassung"
            placeholder="Tasten drücken…"
            active={info ? draft.capture_shortcut === view?.settings.capture_shortcut && info.capture_shortcut_active : undefined}
          />
        </Row>
      </Group>
    </>
  );
}

/** Records a global shortcut from the pressed keys; `active` shows whether the saved one is registered. */
function ShortcutField({ value, onChange, label, placeholder, active }: { value: string; onChange: (v: string) => void; label: string; placeholder: string; active?: boolean }) {
  return (
    <div className="unit-input shortcut-input">
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          const next = recordShortcut(e.nativeEvent);
          if (next === undefined) return;
          e.preventDefault();
          if (next !== null) onChange(next);
        }}
        placeholder={placeholder}
        aria-label={label}
        className="mono"
      />
      {IS_MAC && value && <kbd>{formatShortcut(value)}</kbd>}
      {value && active !== undefined && (active ? <Badge tone="success">Aktiv</Badge> : <Badge tone="warning">Nicht registriert</Badge>)}
    </div>
  );
}

/** Offers to restart now; the move (or switch) happens at the next start either way. */
async function offerRestart(dir: string, what: string) {
  const s = useApp.getState();
  const restart = await s.confirm({
    title: "Neustart erforderlich",
    message: `${what} Bis dahin arbeitest du normal im bisherigen Ordner weiter – es geht nichts verloren, auch wenn du erst später neu startest.`,
    confirmLabel: "Jetzt neu starten",
    cancelLabel: "Später",
  });
  if (restart) return restartApp();
  s.toast({
    tone: "info",
    persistent: true,
    title: "Neustart ausstehend",
    detail: `Der Speicherort ${dir} gilt ab dem nächsten Start.`,
    action: { label: "Jetzt neu starten", run: () => void restartApp() },
  });
}

async function restartApp() {
  try {
    await flushAllEditors();
    await api.restart();
  } catch (e) {
    useApp.getState().error("Neustart fehlgeschlagen", e);
  }
}

async function moveDataDir(onChanged: () => void) {
  const s = useApp.getState();
  const dir = await pickFolder("Neuer Speicherort für die Daten");
  if (!dir) return;
  try {
    const target = await api.inspectDataDir(dir);
    let useExisting = false;
    if (target.has_workspace) {
      useExisting = await s.confirm({
        title: "Vorhandenen Arbeitsbereich verwenden?",
        message: `In ${dir} liegt bereits ein Annalo-Arbeitsbereich. Nach dem Neustart wird dieser geöffnet; es werden keine Daten kopiert. Der aktuelle Arbeitsbereich bleibt unverändert im bisherigen Ordner.`,
        confirmLabel: "Vorhandenen verwenden",
      });
      if (!useExisting) return;
    }
    await api.setDataDir(dir, useExisting);
    onChanged();
    const warn = target.synced ? " Achtung: Der Ordner ist synchronisiert oder liegt im Netzwerk – das kann die Datenbank beschädigen." : "";
    await offerRestart(
      dir,
      useExisting
        ? `Beim nächsten Start wird der Arbeitsbereich in ${dir} geöffnet.${warn}`
        : `Beim nächsten Start werden Datenbank, Bilder und Sicherungen nach ${dir} kopiert und ab dann von dort geladen. Der alte Ordner bleibt unverändert.${warn}`,
    );
  } catch (e) {
    s.error("Speicherort nicht geändert", e);
  }
}

function UpdatesGroup({ draft, update }: { draft: Settings; update: (p: Partial<Settings>) => void }) {
  const t = useT();
  const { status, available, phase, checkedAt } = useUpdates();
  useEffect(() => void loadUpdateStatus(), []);
  if (!status) return null;
  const busy = phase === "downloading" || phase === "installing";
  let state: React.ReactNode;
  if (!status.enabled) state = NOT_CONFIGURED + ".";
  else if (available) state = `Version ${available.version} ist verfügbar.`;
  else if (phase === "checking") state = "Suche nach Updates …";
  else if (checkedAt) state = `Annalo ist aktuell (geprüft ${relative(checkedAt.toISOString())}).`;
  else state = "Noch nicht geprüft.";
  return (
    <Group title={t("set.about.updates")} description="Neue Versionen kommen als signierte Installer von GitHub. Installiert wird nur nach deinem Klick; offene Notizen werden vorher gespeichert.">
      <Row label="Status" description={<span className="update-state">{state}</span>}>
        <div className="unit-input">
          {available && status.enabled && (
            <>
              <Button variant="ghost" onClick={() => useUpdates.setState({ notesOpen: true })}>
                Was ist neu?
              </Button>
              <Button variant="primary" icon={RefreshCw} loading={busy} onClick={() => void installUpdate()}>
                Installieren und neu starten
              </Button>
            </>
          )}
          <Button
            icon={RefreshCw}
            disabled={!status.enabled || busy}
            loading={phase === "checking"}
            title={status.enabled ? undefined : NOT_CONFIGURED}
            onClick={() => void checkForUpdates(true)}
          >
            Jetzt nach Updates suchen
          </Button>
        </div>
      </Row>
      {status.enabled && (
        <Row label="Automatisch nach Updates suchen" description="Beim Start und alle 6 Stunden. Du wirst gefragt, bevor etwas installiert wird.">
          <Switch label="Automatisch nach Updates suchen" checked={draft.auto_update_check} onChange={(v) => update({ auto_update_check: v })} />
        </Row>
      )}
    </Group>
  );
}

function AboutSection({ draft, update }: { draft: Settings; update: (p: Partial<Settings>) => void }) {
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
  ];
  return (
    <>
      <header className="settings-head about-head">
        <span className="about-mark">
          <AnnaloLogo size={34} />
        </span>
        <div>
          <h1>Annalo</h1>
          <p>Version {version}</p>
        </div>
      </header>
      <UpdatesGroup draft={draft} update={update} />
      <Group title={t("set.about.data")}>
        <Row label={t("set.about.dataDir")} description="Datenbank, Einstellungen und Schlüsselablage (unter Linux).">
          <span className="mono small selectable">{view.data_dir}</span>
        </Row>
        {status?.pending_move && (
          <Row label="Beim nächsten Start" description="Der Speicherort wechselt beim nächsten Start. Bis dahin bleibt alles im bisherigen Ordner.">
            <div className="unit-input">
              <span className="mono small selectable">{status.pending_move}</span>
              <Button onClick={() => void restartApp()}>Jetzt neu starten</Button>
              <Button
                variant="ghost"
                onClick={async () => {
                  try {
                    setStatus(await api.cancelDataDirMove());
                  } catch (e) {
                    useApp.getState().error("Nicht verworfen", e);
                  }
                }}
              >
                Verwerfen
              </Button>
            </div>
          </Row>
        )}
        <Row label={t("set.about.moveData")} description="Kopiert Datenbank, Bilder und Sicherungen beim nächsten Start in einen anderen Ordner. Der alte Ordner bleibt unverändert. Kein OneDrive-, Dropbox- oder Netzwerkordner.">
          <Button icon={FolderInput} onClick={() => moveDataDir(loadStatus)}>
            Speicherort ändern…
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
