// The setup steps. Each one is thin: it writes its answer to the settings at once (write.ts,
// flow.ts) through the existing APIs, and links to its settings section for the rest.

import { useEffect, useState, type ReactNode } from "react";
import {
  Check, CheckCircle2, ChevronRight, Cloud, Cpu, CalendarRange, DatabaseBackup, FilePlus2, FolderInput, FolderOpen, GitBranch, Globe, LayoutDashboard, Loader2, Lock, MinusCircle, Monitor, Moon, PlugZap, RefreshCw, Server, ShieldCheck, Sparkles, Sun, Timer, XCircle,
  type LucideIcon,
} from "lucide-react";
import { api } from "../lib/api";
import { importVault } from "../lib/actions";
import { Badge, Button, Input, Segmented, Switch } from "../components/ui";
import { translate, useT, type LanguageChoice, type TKey } from "../lib/i18n";
import { weekdayLabels } from "../lib/format";
import { IS_MAC } from "../lib/platform";
import { formatShortcut, keys } from "../lib/shortcut";
import { KIND_LABELS, PRESETS, fromPreset, localTierNotLocal, providerName } from "../lib/providers";
import { BUILTIN_THEMES, findTheme, themeName } from "../lib/themes";
import { aiSwitchOn } from "../lib/aiswitch";
import { openSettingsSection } from "../lib/calnav";
import { zeitCommand } from "../editor/zeit-suggest";
import type { AiProvider, CalendarStatus, DataDirStatus, OllamaDetect, ProviderKind, ProviderTest, SettingsView } from "../lib/types";
import { useApp } from "../store/app";
import { NumberInput, PathValue } from "../views/settings/common";
import { ThemeMock } from "../views/settings/ThemeEditor";
import { ProviderDialog } from "../views/settings/ProviderDialog";
import {
  LATER, ROUNDING_STEPS, STEPS, STEP_SECTIONS, aiChoiceOf, clampTarget, companyProvider, isUntouchedDefault, stepIndex, summaryRows, timeTrackingOn, withAi, withCompanyProvider, withLocalModel, withRounding, withThemePick, withTimeTracking, withWorkday, type AiChoice, type StepId,
} from "./flow";
import { applyLanguage, osLanguage } from "./lang";
import { finishFirstRun, pauseForSettings, useFirstRun } from "./state";
import { writeSettings } from "./write";

type Write = typeof writeSettings;

/** Heading, lead sentence and the link to the settings section of a step. */
export function StepFrame({ step, title, lead, children }: { step: StepId; title: TKey; lead: TKey; children: ReactNode }) {
  const t = useT();
  const section = STEP_SECTIONS[step];
  return (
    <div className={`fr-step fr-step-${step}`}>
      <div className="fr-step-count">{t("fr.stepOf", { n: stepIndex(step) + 1, total: STEPS.length })}</div>
      <h2 className="fr-step-title" tabIndex={-1} data-step-title>
        {t(title)}
      </h2>
      <p className="fr-step-lead">{t(lead)}</p>
      <div className="fr-step-body">{children}</div>
      {section && step !== "done" && (
        <button type="button" className="fr-more" onClick={() => pauseForSettings(step)}>
          {t("fr.more")}
        </button>
      )}
    </div>
  );
}

/** A large radio card. */
function Choice({ on, icon: Icon, title, text, onPick, disabled, badge, name }: { on: boolean; icon: LucideIcon; title: string; text: string; onPick: () => void; disabled?: boolean; badge?: string; name?: string }) {
  return (
    <button type="button" role="radio" aria-checked={on} className={`fr-choice ${on ? "on" : ""}`} onClick={onPick} disabled={disabled} data-choice={name}>
      <span className="fr-choice-icon" aria-hidden>
        <Icon size={18} strokeWidth={1.8} />
      </span>
      <span className="fr-choice-text">
        <span className="fr-choice-title">
          {title}
          {badge && <Badge>{badge}</Badge>}
        </span>
        <span className="fr-choice-sub">{text}</span>
      </span>
      <span className="fr-choice-check" aria-hidden>
        {on && <Check size={12} strokeWidth={3} />}
      </span>
    </button>
  );
}

/** Arrow keys move between the cards of a radio group (like native radios). */
function ChoiceGroup({ label, children, className = "" }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div
      className={`fr-choices ${className}`}
      role="radiogroup"
      aria-label={label}
      onKeyDown={(e) => {
        if (!["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft"].includes(e.key)) return;
        const all = [...e.currentTarget.querySelectorAll<HTMLButtonElement>(".fr-choice:not(:disabled)")];
        const i = all.indexOf(document.activeElement as HTMLButtonElement);
        if (i < 0) return;
        e.preventDefault();
        e.stopPropagation();
        const d = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : -1;
        all[(i + d + all.length) % all.length]?.focus();
      }}
    >
      {children}
    </div>
  );
}

function Note({ tone = "neutral", icon: Icon, children }: { tone?: "neutral" | "success" | "warning" | "info"; icon?: LucideIcon; children: ReactNode }) {
  return (
    <div className={`fr-note tone-${tone}`}>
      {Icon && <Icon size={14} strokeWidth={2} aria-hidden />}
      <span>{children}</span>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="fr-field">
      <div className="fr-field-label">{label}</div>
      <div className="fr-field-control">{children}</div>
      {hint && <div className="fr-field-hint">{hint}</div>}
    </div>
  );
}

// ------------------------------------------------------------------- language

export function LanguageStep({ view }: { view: SettingsView }) {
  const t = useT();
  const lang = view.settings.locale.language;
  const os = osLanguage();
  const pick = (l: LanguageChoice) => void applyLanguage(l);
  return (
    <StepFrame step="language" title="fr.lang.title" lead="fr.lang.lead">
      <ChoiceGroup label={t("fr.step.language")}>
        <Choice name="system" on={lang === "system"} icon={Monitor} title={t("set.locale.followSystem")} text={t("fr.lang.systemText", { lang: os === "de" ? "Deutsch" : "English" })} onPick={() => pick("system")} />
        {/* Each language describes itself in its own words, whatever the interface language. */}
        <Choice name="de" on={lang === "de"} icon={Globe} title="Deutsch" text={translate("de", "fr.lang.deText")} onPick={() => pick("de")} />
        <Choice name="en" on={lang === "en"} icon={Globe} title="English" text={translate("en", "fr.lang.enText")} onPick={() => pick("en")} />
      </ChoiceGroup>
      <Note icon={RefreshCw}>{t("fr.lang.live")}</Note>
    </StepFrame>
  );
}

// ---------------------------------------------------------------------- theme

const THEME_PICKS = ["arcalo-light", "github-light", "catppuccin-latte", "rose-pine-dawn", "arcalo-dark", "tokyo-night", "nord", "catppuccin-mocha"];

export function ThemeStep({ view, write }: { view: SettingsView; write: Write }) {
  const t = useT();
  const s = view.settings;
  const a = s.appearance;
  const light = findTheme(a.theme_light, a, false);
  const dark = findTheme(a.theme_dark, a, true);
  const defs = THEME_PICKS.map((id) => BUILTIN_THEMES.find((d) => d.id === id)!).filter(Boolean);
  return (
    <StepFrame step="theme" title="fr.theme.title" lead="fr.theme.lead">
      <ChoiceGroup label={t("set.appearance.mode")} className="three">
        <Choice name="system" on={s.theme === "system"} icon={Monitor} title={t("set.appearance.system")} text={t("fr.theme.system")} onPick={() => write((x) => ({ ...x, theme: "system" }))} />
        <Choice name="light" on={s.theme === "light"} icon={Sun} title={t("set.appearance.light")} text={t("fr.theme.light")} onPick={() => write((x) => ({ ...x, theme: "light" }))} />
        <Choice name="dark" on={s.theme === "dark"} icon={Moon} title={t("set.appearance.dark")} text={t("fr.theme.dark")} onPick={() => write((x) => ({ ...x, theme: "dark" }))} />
      </ChoiceGroup>
      <div className="fr-sub">{t("fr.theme.colors")}</div>
      <div className="theme-grid fr-theme-grid" role="radiogroup" aria-label={t("fr.theme.colors")}>
        {defs.map((d) => {
          const on = (d.dark ? dark : light).id === d.id;
          return (
            <div
              key={d.id}
              role="radio"
              tabIndex={0}
              aria-checked={on}
              aria-label={themeName(d)}
              data-theme-card={d.id}
              className={`theme-card ${on ? "on" : ""}`}
              onClick={() => write((x) => withThemePick(x, d))}
              onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), write((x) => withThemePick(x, d)))}
            >
              <ThemeMock def={d} />
              <span className="theme-card-foot">
                <span className="theme-card-name">{themeName(d)}</span>
                {on && <Check size={14} strokeWidth={2.5} className="theme-card-check" aria-hidden />}
              </span>
            </div>
          );
        })}
      </div>
    </StepFrame>
  );
}

// ------------------------------------------------------------------------- AI

const COMPANY_KINDS: { kind: ProviderKind; preset: string }[] = [
  { kind: "litellm", preset: "litellm" },
  { kind: "openai", preset: "custom" },
  { kind: "azure", preset: "azure" },
];

/**
 * „Mit KI“ / „Ohne KI“ first, one honest sentence each; with AI, which model (later, a local
 * Ollama or the company's server). „Ohne KI“ only switches „KI verwenden“ off: providers set up
 * before stay as they are and come back with the switch.
 */
export function AiStep({ view, write }: { view: SettingsView; write: Write }) {
  const t = useT();
  const s = view.settings;
  const keys = view.provider_keys;
  const policyOff = !!view.ai_policy_off;
  const withAiOn = aiSwitchOn(s) && !policyOff;
  const [choice, setChoice] = useState<AiChoice>(() => aiChoiceOf(s, keys));
  const [ollama, setOllama] = useState<OllamaDetect | null>(null);
  const [searching, setSearching] = useState(false);
  const [editing, setEditing] = useState<AiProvider | null>(null);
  const [test, setTest] = useState<ProviderTest | null>(null);
  const [testing, setTesting] = useState(false);
  const company = companyProvider(s, keys);
  const configured = company && company.enabled && !isUntouchedDefault(company, keys) ? company : null;
  const local = s.providers.find((p) => p.enabled && p.local) ?? null;

  const detect = async () => {
    setSearching(true);
    try {
      const d = await api.detectOllama();
      setOllama(d);
      if (d.found) await write((x) => withLocalModel(x, d, keys));
    } catch {
      setOllama({ found: false, url: "", version: null, models: [] });
    } finally {
      setSearching(false);
    }
  };
  const pick = (c: AiChoice) => {
    setChoice(c);
    setTest(null);
    if (c === "local") void detect();
  };
  const editCompany = (kind: ProviderKind) => {
    const preset = PRESETS.find((p) => p.key === COMPANY_KINDS.find((k) => k.kind === kind)!.preset)!;
    // The configured server (or the LiteLLM entry of fresh settings) is edited in place.
    const base = company && company.kind === kind ? company : fromPreset(preset, s.providers);
    setEditing(base);
  };
  const saved = async (p: AiProvider) => {
    setEditing(null);
    const models = await api.providerModels(p).then((r) => (r.ok ? r.models : []), () => []);
    const next = await write((x) => withCompanyProvider(x, p, models, useApp.getState().settings?.provider_keys ?? keys));
    if (next) setTest(null);
  };
  const runTest = async (p: AiProvider) => {
    setTesting(true);
    try {
      setTest(await api.testProvider(p));
    } catch (e) {
      setTest({ steps: [{ id: "reach", ok: false, detail: String(e), latency_ms: 0 }], models: [], model: null });
    } finally {
      setTesting(false);
    }
  };
  const target = choice === "local" ? local : configured;
  const leak = withAiOn && choice !== "none" ? localTierNotLocal(s) : null;

  return (
    <StepFrame step="ai" title="fr.ai.title" lead="fr.ai.lead">
      <ChoiceGroup label={t("fr.step.ai")} className="two">
        <Choice name="with" on={withAiOn} icon={Sparkles} title={t("fr.ai.with")} text={t("fr.ai.withText")} disabled={policyOff} onPick={() => void write((x) => withAi(x, true))} />
        <Choice name="without" on={!withAiOn} icon={MinusCircle} title={t("fr.ai.without")} text={t("fr.ai.withoutText")} onPick={() => void write((x) => withAi(x, false))} />
      </ChoiceGroup>
      {policyOff && <Note icon={Lock}>{t("noai.policyText")}</Note>}

      {withAiOn && (
        <>
          <div className="fr-sub">{t("fr.ai.which")}</div>
          <ChoiceGroup label={t("fr.ai.which")} className="three">
            <Choice name="later" on={choice === "none"} icon={MinusCircle} title={t("fr.ai.none")} text={t("fr.ai.noneText")} onPick={() => pick("none")} />
            <Choice name="local" on={choice === "local"} icon={Cpu} title={t("fr.ai.local")} text={t("fr.ai.localText")} onPick={() => pick("local")} />
            <Choice name="company" on={choice === "company"} icon={Server} title={t("fr.ai.company")} text={t("fr.ai.companyText")} onPick={() => pick("company")} />
          </ChoiceGroup>

          {choice === "local" && (
            <div className="fr-panel" aria-live="polite">
              {searching ? (
                <Note icon={Loader2}>{t("fr.ai.searching")}</Note>
              ) : ollama?.found || local ? (
                <Note tone="success" icon={CheckCircle2}>
                  {ollama?.found
                    ? t("fr.ai.found", { version: ollama.version ?? "", n: ollama.models.length })
                    : t("fr.ai.localSet", { name: local ? providerName(local) : "" })}
                  {ollama?.found && !ollama.models.length ? ` ${t("fr.ai.noModels")}` : ""}
                </Note>
              ) : ollama ? (
                <Note tone="warning" icon={XCircle}>
                  {t("fr.ai.notFound")}
                </Note>
              ) : null}
              <div className="fr-inline">
                <Button icon={RefreshCw} onClick={() => void detect()} loading={searching}>
                  {t("fr.ai.search")}
                </Button>
                {local && (
                  <Button icon={PlugZap} onClick={() => void runTest(local)} loading={testing}>
                    {t("fr.ai.test")}
                  </Button>
                )}
              </div>
            </div>
          )}

          {choice === "company" && (
            <div className="fr-panel">
              <div className="fr-panel-head">
                <Cloud size={14} strokeWidth={1.9} aria-hidden />
                {configured ? providerName(configured) : t("fr.ai.kind")}
                {configured && (keys.includes(configured.id) ? <Badge tone="success">{t("fr.ai.keySaved")}</Badge> : <Badge>{t("fr.ai.noKey")}</Badge>)}
              </div>
              {configured && <PathValue value={configured.base_url} className="fr-path" />}
              <div className="fr-inline">
                {COMPANY_KINDS.map(({ kind }) => (
                  <Button key={kind} variant={configured?.kind === kind ? "primary" : "secondary"} onClick={() => editCompany(kind)} data-kind={kind}>
                    {configured?.kind === kind ? t("fr.ai.editServer", { kind: KIND_LABELS[kind] }) : KIND_LABELS[kind]}
                  </Button>
                ))}
              </div>
              <p className="fr-panel-text">{t("fr.ai.companyHint")}</p>
              {configured && (
                <div className="fr-inline">
                  <Button icon={PlugZap} onClick={() => void runTest(configured)} loading={testing}>
                    {t("fr.ai.test")}
                  </Button>
                </div>
              )}
            </div>
          )}

          {test && target && (
            <div className="fr-test" role="status">
              {test.steps.map((st) => (
                <span key={st.id} className={`fr-test-step ${st.ok ? "ok" : st.ok === false ? "fail" : ""}`} title={st.detail}>
                  {st.ok ? <CheckCircle2 size={13} /> : st.ok === false ? <XCircle size={13} /> : <MinusCircle size={13} />}
                  {t(`fr.ai.test.${st.id}` as TKey)}
                </span>
              ))}
            </div>
          )}

          <Note icon={ShieldCheck}>{t("fr.ai.privacy")}</Note>
          {leak && <Note tone="warning">{t("fr.ai.leak", { name: providerName(leak) })}</Note>}
        </>
      )}
      {!withAiOn && !policyOff && <Note icon={ShieldCheck}>{t("fr.ai.offNote")}</Note>}

      {editing && (
        <ProviderDialog
          initial={editing}
          isNew={!s.providers.some((p) => p.id === editing.id)}
          keySet={keys.includes(editing.id)}
          hint={PRESETS.find((p) => p.kind === editing.kind && p.key !== "custom")?.hint}
          onClose={() => setEditing(null)}
          onSave={(p) => void saved(p)}
        />
      )}
    </StepFrame>
  );
}

// ----------------------------------------------------------------------- work

/** „Buchst du Zeit?“: time tracking on or off; with it the week and the rounding. SAP CATS and
 * Jira are details for the settings. */
export function WorkStep({ view, write }: { view: SettingsView; write: Write }) {
  const t = useT();
  const s = view.settings;
  const on = timeTrackingOn(s);
  const r = s.time.rounding;
  return (
    <StepFrame step="work" title="fr.work.title" lead="fr.work.lead">
      <ChoiceGroup label={t("fr.work.sapQuestion")} className="two">
        <Choice name="sap" on={on} icon={Timer} title={t("fr.work.sapYes")} text={t("fr.work.sapYesText")} onPick={() => write((x) => withTimeTracking(x, true))} />
        <Choice name="nosap" on={!on} icon={MinusCircle} title={t("fr.work.sapNo")} text={t("fr.work.sapNoText")} onPick={() => write((x) => withTimeTracking(x, false))} />
      </ChoiceGroup>
      <div className="fr-fields">
        <Field label={t("set.time.workdays")} hint={t("fr.work.daysHint")}>
          <div className="day-toggle" role="group" aria-label={t("set.time.workdays")}>
            {weekdayLabels(1).map((d, i) => {
              const day = s.workdays.includes(i + 1);
              return (
                <button key={d} type="button" aria-pressed={day} className={day ? "on" : ""} onClick={() => write((x) => withWorkday(x, i + 1, !day))}>
                  {d}
                </button>
              );
            })}
          </div>
        </Field>
        {on && (
          <>
            <Field label={t("set.time.target")}>
              <div className="unit-input">
                <NumberInput min={0.5} max={16} step={0.25} value={s.daily_target_hours} onCommit={(v) => write((x) => ({ ...x, daily_target_hours: clampTarget(v) }))} aria-label={t("set.time.target")} />
                <span className="faint">{t("fr.work.hours")}</span>
              </div>
            </Field>
            <Field label={t("fr.work.rounding")} hint={t("fr.work.roundingHint")}>
              <div className="fr-inline">
                <Segmented
                  label={t("fr.work.rounding")}
                  value={String(ROUNDING_STEPS.includes(r.step_minutes as never) ? r.step_minutes : 0)}
                  options={ROUNDING_STEPS.map((n) => ({ value: String(n), label: n ? `${n} ${t("unit.min")}` : t("fr.work.off") }))}
                  onChange={(v) => write((x) => withRounding(x, Number(v)))}
                />
                {r.step_minutes > 0 && (
                  <Segmented
                    label={t("fr.work.roundMode")}
                    value={r.mode}
                    options={[
                      { value: "up", label: t("fr.work.up") },
                      { value: "nearest", label: t("fr.work.nearest") },
                    ]}
                    onChange={(v) => write((x) => withRounding(x, x.time.rounding.step_minutes, v))}
                  />
                )}
              </div>
            </Field>
          </>
        )}
      </div>
      <Note icon={on ? Server : MinusCircle}>{t(on ? "fr.work.export" : "fr.work.hidden")}</Note>
    </StepFrame>
  );
}

// ------------------------------------------------------------------- calendar

export function CalendarStep({ view, write }: { view: SettingsView; write: Write }) {
  const t = useT();
  const s = view.settings;
  const [status, setStatus] = useState<CalendarStatus | null>(null);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.calendarStatus().then(setStatus, () => setStatus(null));
  }, [s.calendar.outlook]);
  const ics = status?.sources.filter((x) => x.kind !== "outlook") ?? [];
  const add = async () => {
    const u = url.trim();
    if (!u) return;
    setBusy(true);
    try {
      setStatus(await api.calendarSourceAdd(t("fr.cal.icsName"), { url: u }));
      await useApp.getState().refreshSettings();
      setUrl("");
    } catch (e) {
      useApp.getState().error(t("nav.calendar"), e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <StepFrame step="calendar" title="fr.cal.title" lead={timeTrackingOn(view.settings) ? "fr.cal.lead" : "fr.cal.leadNoTime"}>
      {status?.outlook_available && (
        <div className={`fr-toggle-card ${s.calendar.outlook ? "on" : ""}`}>
          <span className="fr-choice-icon" aria-hidden>
            <CalendarRange size={18} strokeWidth={1.8} />
          </span>
          <span className="fr-choice-text">
            <span className="fr-choice-title">{t("fr.cal.outlook")}</span>
            <span className="fr-choice-sub">{t("fr.cal.outlookText")}</span>
          </span>
          <Switch label={t("fr.cal.outlook")} checked={s.calendar.outlook} onChange={(v) => void write((x) => ({ ...x, calendar: { ...x.calendar, outlook: v } }))} />
        </div>
      )}
      <Field label={t("fr.cal.ics")} hint={t("fr.cal.icsHint")}>
        <div className="fr-inline grow">
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void add()}
            placeholder="https://… .ics"
            aria-label={t("fr.cal.ics")}
            className="grow"
          />
          <Button onClick={() => void add()} disabled={!url.trim()} loading={busy}>
            {t("common.add")}
          </Button>
        </div>
      </Field>
      {ics.length > 0 && (
        <ul className="fr-list" aria-label={t("fr.cal.ics")}>
          {ics.map((c) => (
            <li key={c.id}>
              <span className="calset-color" style={{ background: c.color }} aria-hidden />
              {c.name}
              <span className="faint">{c.address}</span>
            </li>
          ))}
        </ul>
      )}
      {!status?.outlook_available && <Note>{t("fr.cal.noOutlook")}</Note>}
      <Note icon={Lock}>{t("fr.cal.private")}</Note>
    </StepFrame>
  );
}

// ------------------------------------------------------------------ workspace

export function WorkspaceStep({ view }: { view: SettingsView }) {
  const t = useT();
  const picked = useFirstRun((st) => st.workspace);
  const [busy, setBusy] = useState(false);
  const [projects, setProjects] = useState<number | null>(null);
  const [dir, setDir] = useState<DataDirStatus | null>(null);
  const pages = useApp((st) => st.tree.length);
  useEffect(() => {
    api.wbs().then((w) => setProjects(w.length), () => setProjects(0));
    api.dataDirStatus().then(setDir, () => setDir(null));
  }, [picked]);
  const s = useApp.getState;
  const run = async (choice: "samples" | "import" | "empty") => {
    setBusy(true);
    try {
      if (choice !== "empty" || pages === 0) await api.finishOnboarding(choice === "samples");
      await s().refreshTree();
      s().bumpWbs();
      s().set({ onboarding: false });
      useFirstRun.setState({ workspace: choice });
      if (choice === "import") await importVault();
    } catch (e) {
      s().error(t("fr.saveFailed"), e);
    } finally {
      setBusy(false);
    }
  };
  const hasData = pages > 0 || (projects ?? 0) > 0;
  return (
    <StepFrame step="workspace" title="fr.ws.title" lead={hasData ? "fr.ws.leadExisting" : "fr.ws.lead"}>
      <ChoiceGroup label={t("fr.step.workspace")} className="three">
        <Choice name="samples" on={picked === "samples"} icon={LayoutDashboard} title={t("fr.ws.samples")} text={t(projects ? "fr.ws.samplesHas" : "fr.ws.samplesText")} disabled={busy || !!projects} onPick={() => run("samples")} />
        <Choice name="empty" on={picked === "empty"} icon={FilePlus2} title={t(hasData ? "fr.ws.keep" : "fr.ws.empty")} text={t(hasData ? "fr.ws.keepText" : "fr.ws.emptyText")} disabled={busy} onPick={() => run("empty")} />
        <Choice name="import" on={picked === "import"} icon={FolderInput} title={t("fr.ws.import")} text={t("fr.ws.importText")} disabled={busy} onPick={() => run("import")} />
      </ChoiceGroup>
      <div className="fr-panel">
        <div className="fr-panel-head">
          <FolderOpen size={14} strokeWidth={1.9} aria-hidden />
          {t("fr.ws.folder")}
          {dir?.portable && <Badge tone="info">{t("set.about.portable")}</Badge>}
        </div>
        <PathValue value={dir?.data_dir ?? view.data_dir} className="fr-path" />
        <p className="fr-panel-text">{t(dir?.portable ? "fr.ws.portable" : "fr.ws.folderText")}</p>
        {dir?.synced && <Note tone="warning">{t("fr.ws.synced")}</Note>}
      </div>
    </StepFrame>
  );
}

// ----------------------------------------------------------------------- done

const LATER_ICONS: Record<string, LucideIcon> = { "fr.later.backup": DatabaseBackup, "fr.later.sync": GitBranch, "fr.later.security": Lock, "fr.later.desktop": Monitor };

export function DoneStep({ view, onEdit }: { view: SettingsView; onEdit: (step: StepId) => void }) {
  const t = useT();
  const workspace = useFirstRun((st) => st.workspace);
  const [ics, setIcs] = useState(0);
  useEffect(() => {
    api.calendarStatus().then((c) => setIcs(c.sources.filter((x) => x.kind !== "outlook").length), () => {});
  }, []);
  const rows = summaryRows(view.settings, { t, weekdays: weekdayLabels(1), keys: view.provider_keys, icsCount: ics, workspace, aiPolicyOff: !!view.ai_policy_off });
  const capture = view.settings.capture_shortcut;
  const tips: [string, TKey][] = [
    [keys("Mod K"), "fr.tip.palette"],
    // Without time tracking there is no /zeit to tell about.
    ...(timeTrackingOn(view.settings) ? ([[zeitCommand(), "fr.tip.zeit"]] as [string, TKey][]) : []),
    ["[[ ]]", "fr.tip.links"],
    ...(capture ? ([[formatShortcut(capture, IS_MAC, " "), "fr.tip.capture"]] as [string, TKey][]) : []),
  ];
  // „Später einrichten“: the setup ends (answers are saved) and the section opens.
  const later = async (section: string) => {
    await finishFirstRun();
    openSettingsSection(section);
  };
  return (
    <StepFrame step="done" title="fr.done.title" lead="fr.done.lead">
      <div className="fr-done">
        <div className="fr-done-main">
          <dl className="fr-summary">
            {rows.map((r) => (
              <div key={r.step} className="fr-sum-row" data-sum={r.step}>
                <dt>{t(r.label)}</dt>
                <dd title={r.value}>{r.value}</dd>
                <button type="button" className="fr-edit" onClick={() => onEdit(r.step)} aria-label={t("fr.done.editAria", { what: t(r.label) })}>
                  {t("fr.done.edit")}
                </button>
              </div>
            ))}
          </dl>
          <section className="fr-later" aria-labelledby="fr-later-head">
            <div className="fr-sub" id="fr-later-head">
              {t("fr.later")}
            </div>
            <div className="fr-later-grid">
              {LATER.map((l) => {
                const Icon = LATER_ICONS[l.label];
                return (
                  <button key={l.label} type="button" className="fr-later-item" data-later={l.label.slice(9)} onClick={() => void later(l.section)}>
                    <Icon size={15} strokeWidth={1.8} aria-hidden />
                    <span className="fr-later-text">
                      <span className="fr-later-title">{t(l.label)}</span>
                      <span className="fr-later-sub">{t(l.sub)}</span>
                    </span>
                    <ChevronRight size={14} className="fr-later-go" aria-hidden />
                  </button>
                );
              })}
            </div>
          </section>
        </div>
        <aside className="fr-tips" aria-label={t("fr.tips")}>
          <div className="fr-tips-head">{t("fr.tips")}</div>
          {tips.map(([k, label]) => (
            <div key={label} className="fr-tip">
              <span className="keys">
                {k.split(" ").map((x, i) => (
                  <kbd key={`${x}-${i}`}>{x}</kbd>
                ))}
              </span>
              <span>{t(label)}</span>
            </div>
          ))}
          <p className="fr-tips-foot">{t("fr.tip.rerun")}</p>
        </aside>
      </div>
    </StepFrame>
  );
}
