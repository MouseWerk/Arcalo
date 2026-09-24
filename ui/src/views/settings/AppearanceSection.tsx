// Settings → Darstellung: mode, color themes (a light and a dark one, previews in the theme's
// colors), custom themes (editor, import/export), accent color, fonts, UI scale, density, line
// width, reduced motion and (Windows 11) the Mica backdrop. Changes apply and save immediately.

import { useEffect, useState } from "react";
import { Check, Download, Palette, Pencil, Plus, Trash2, Upload } from "lucide-react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { Button, IconButton, Input, Segmented, Select, Switch } from "../../components/ui";
import { api } from "../../lib/api";
import { ACCENT_PRESETS, accentHex, accentTokens, contrast } from "../../lib/color";
import { useT, type TKey } from "../../lib/i18n";
import { BUILTIN_THEMES, allThemes, effectiveAccent, findTheme, type ThemeDef } from "../../lib/themes";
import type { AppearancePrefs, CustomTheme } from "../../lib/types";
import { useApp } from "../../store/app";
import { Group, Row, SectionHead, type SectionProps } from "./common";
import { ThemeEditor, ThemeMock, newThemeId } from "./ThemeEditor";

export function AppearanceSection({ draft, update }: SectionProps) {
  const t = useT();
  const a = draft.appearance;
  const set = (p: Partial<AppearancePrefs>) => update({ appearance: { ...a, ...p } });
  const [platform, setPlatform] = useState<string | null>(null);
  const [editing, setEditing] = useState<CustomTheme | null>(null);
  useEffect(() => {
    api.appInfo().then((i) => setPlatform(i.platform), () => setPlatform(null));
  }, []);
  // Follows the OS while „System“ is on.
  const [osDark, setOsDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  useEffect(() => {
    const m = window.matchMedia("(prefers-color-scheme: dark)");
    const on = () => setOsDark(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);

  const themes = allThemes(a);
  const lightDef = findTheme(a.theme_light, a, false);
  const darkDef = findTheme(a.theme_dark, a, true);
  const shown = draft.theme === "dark" || (draft.theme === "system" && osDark) ? darkDef : lightDef;

  /** A theme card: sets the slot of its kind; with a fixed mode, the mode follows so the choice is visible. */
  const pick = (def: ThemeDef) => {
    const appearance = { ...a, ...(def.dark ? { theme_dark: def.id } : { theme_light: def.id }) };
    const theme = draft.theme === "system" ? "system" : def.dark ? "dark" : "light";
    update({ theme, appearance });
  };

  const saveCustom = (theme: CustomTheme, use: boolean) => {
    const exists = a.custom_themes.some((c) => c.id === theme.id);
    const t2 = exists ? theme : { ...theme, id: newThemeId(a.custom_themes) };
    const custom_themes = exists ? a.custom_themes.map((c) => (c.id === t2.id ? t2 : c)) : [...a.custom_themes, t2];
    // A theme that changed its kind leaves the slot of the other kind.
    const slots = {
      theme_light: a.theme_light === t2.id && t2.dark ? BUILTIN_THEMES[0].id : a.theme_light,
      theme_dark: a.theme_dark === t2.id && !t2.dark ? BUILTIN_THEMES[1].id : a.theme_dark,
    };
    if (use) Object.assign(slots, t2.dark ? { theme_dark: t2.id } : { theme_light: t2.id });
    const theme2 = use && draft.theme !== "system" ? (t2.dark ? "dark" : "light") : draft.theme;
    update({ theme: theme2, appearance: { ...a, ...slots, custom_themes } });
    useApp.getState().toast({ tone: "success", title: t("set.appearance.themeSaved"), detail: t2.name });
    setEditing(null);
  };

  const removeCustom = async (theme: CustomTheme) => {
    const st = useApp.getState();
    if (!(await st.confirm({ title: t("set.appearance.deleteConfirm", { name: theme.name }), message: t("set.appearance.deleteMessage"), confirmLabel: t("common.remove"), danger: true }))) return;
    set({
      custom_themes: a.custom_themes.filter((c) => c.id !== theme.id),
      theme_light: a.theme_light === theme.id ? BUILTIN_THEMES[0].id : a.theme_light,
      theme_dark: a.theme_dark === theme.id ? BUILTIN_THEMES[1].id : a.theme_dark,
    });
  };

  const exportCustom = async (theme: CustomTheme) => {
    const st = useApp.getState();
    const slug = theme.name.replace(/[\\/:*?"<>|]+/g, "-").trim() || "thema";
    const path = await saveDialog({ defaultPath: `${slug}.json`, filters: [{ name: "JSON", extensions: ["json"] }] });
    if (!path) return;
    try {
      await api.exportTheme(path, theme);
      st.toast({ tone: "success", title: t("set.appearance.themeExported"), detail: path });
    } catch (e) {
      st.error(t("set.appearance.themeExportFailed"), e);
    }
  };

  const importCustom = async () => {
    const st = useApp.getState();
    const path = await openDialog({ multiple: false, directory: false, filters: [{ name: "JSON", extensions: ["json"] }] });
    if (typeof path !== "string") return;
    try {
      const theme = await api.readThemeFile(path);
      // Imported like a saved one: it gets an id and is shown right away.
      saveCustom({ ...theme, name: uniqueName(theme.name, themes) }, true);
      st.toast({ tone: "success", title: t("set.appearance.themeImported"), detail: theme.name });
    } catch (e) {
      st.error(t("set.appearance.themeImportFailed"), e);
    }
  };

  return (
    <>
      <SectionHead title={t("set.appearance.title")} intro={t("set.appearance.intro")} />
      <Group title={t("set.appearance.themes")} description={t("set.appearance.themesDesc")}>
        <Row label={t("set.appearance.mode")}>
          <Segmented
            label={t("set.appearance.mode")}
            value={draft.theme}
            options={[
              { value: "system", label: t("set.appearance.system") },
              { value: "light", label: t("set.appearance.light") },
              { value: "dark", label: t("set.appearance.dark") },
            ]}
            onChange={(v) => update({ theme: v })}
          />
        </Row>
        {([false, true] as const).map((dark) => (
          <Row
            key={String(dark)}
            stack
            label={t(dark ? "set.appearance.darkTheme" : "set.appearance.lightTheme")}
            description={t(dark ? "set.appearance.darkThemeDesc" : "set.appearance.lightThemeDesc")}
            keywords={themes.filter((d) => d.dark === dark).map((d) => d.name).join(" ")}
          >
            <div className="theme-grid" role="radiogroup" aria-label={t(dark ? "set.appearance.darkTheme" : "set.appearance.lightTheme")}>
              {themes
                .filter((d) => d.dark === dark)
                .map((d) => {
                  const on = (dark ? darkDef : lightDef).id === d.id;
                  const now = shown.id === d.id;
                  return (
                    <div
                      key={d.id}
                      role="radio"
                      tabIndex={0}
                      aria-checked={on}
                      aria-label={d.name}
                      data-theme-card={d.id}
                      className={`theme-card ${on ? "on" : ""} ${now ? "shown" : ""}`}
                      onClick={() => pick(d)}
                      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), pick(d))}
                    >
                      <ThemeMock def={d} />
                      <span className="theme-card-foot">
                        <span className="theme-card-name">{d.name}</span>
                        {now && <span className="theme-card-now">{t("set.appearance.shownNow")}</span>}
                        {on && <Check size={14} strokeWidth={2.5} className="theme-card-check" aria-hidden />}
                      </span>
                    </div>
                  );
                })}
            </div>
          </Row>
        ))}
        <AccentRow a={a} set={set} light={lightDef} dark={darkDef} shown={shown} />
      </Group>

      <Group title={t("set.appearance.custom")} description={t("set.appearance.customDesc")}>
        <Row label={t("set.appearance.newTheme")} description={t("set.appearance.newThemeDesc")}>
          <Button icon={Plus} onClick={() => setEditing({ id: "", name: uniqueName(`${shown.name} (eigenes)`, themes), dark: shown.dark, colors: { ...shown.colors } })}>
            {t("set.appearance.newTheme")}
          </Button>
          <Button variant="ghost" icon={Upload} onClick={importCustom}>
            {t("set.appearance.importTheme")}
          </Button>
        </Row>
        {a.custom_themes.map((c) => (
          <Row key={c.id} label={c.name} description={t("set.appearance.customKind", { kind: t(c.dark ? "set.appearance.dark" : "set.appearance.light") })}>
            <span className="theme-swatches" aria-hidden>
              {(["background", "surface", "text", "accent"] as const).map((k) => (
                <i key={k} style={{ background: c.colors[k] }} />
              ))}
            </span>
            <Button icon={Pencil} onClick={() => setEditing(c)}>
              {t("set.appearance.editTheme")}
            </Button>
            <Button variant="ghost" icon={Download} onClick={() => exportCustom(c)}>
              {t("set.appearance.exportTheme")}
            </Button>
            <IconButton icon={Trash2} label={t("set.appearance.deleteTheme")} onClick={() => removeCustom(c)} />
          </Row>
        ))}
      </Group>

      <Group title={t("set.appearance.fonts")}>
        <Row label={t("set.appearance.uiFont")}>
          <Segmented
            label={t("set.appearance.uiFont")}
            value={a.ui_font}
            options={[
              { value: "inter", label: "Inter" },
              { value: "system", label: t("set.appearance.systemFont") },
            ]}
            onChange={(v) => set({ ui_font: v })}
          />
        </Row>
        <Row label={t("set.appearance.editorFont")}>
          <Segmented
            label={t("set.appearance.editorFont")}
            value={a.editor_font}
            options={[
              { value: "sans", label: t("set.appearance.sans") },
              { value: "serif", label: t("set.appearance.serif") },
              { value: "mono", label: t("set.appearance.mono") },
            ]}
            onChange={(v) => set({ editor_font: v })}
          />
        </Row>
        <Row label={t("set.appearance.codeFont")}>
          <Segmented
            label={t("set.appearance.codeFont")}
            value={a.code_font}
            options={[
              { value: "jetbrains", label: "JetBrains Mono" },
              { value: "system", label: t("set.appearance.systemFont") },
            ]}
            onChange={(v) => set({ code_font: v })}
          />
        </Row>
      </Group>

      <Group title={t("set.appearance.layout")}>
        <Row label={t("set.appearance.scale")} description={t("set.appearance.scaleDesc")}>
          <Select value={String(a.ui_scale)} onChange={(e) => set({ ui_scale: Number(e.target.value) })} aria-label={t("set.appearance.scale")}>
            {[90, 95, 100, 105, 110, 115, 120, 125].map((p) => (
              <option key={p} value={p}>
                {p} %
              </option>
            ))}
          </Select>
        </Row>
        <Row label={t("set.appearance.density")}>
          <Segmented
            label={t("set.appearance.density")}
            value={a.density}
            options={[
              { value: "compact", label: t("set.appearance.compact") },
              { value: "normal", label: t("set.appearance.normal") },
              { value: "comfortable", label: t("set.appearance.comfortable") },
            ]}
            onChange={(v) => set({ density: v })}
          />
        </Row>
        <Row label={t("set.appearance.lineWidth")} description={t("set.appearance.lineWidthDesc")}>
          <Segmented
            label={t("set.appearance.lineWidth")}
            value={a.line_width}
            options={[
              { value: "narrow", label: t("set.appearance.narrow") },
              { value: "normal", label: t("set.appearance.normal") },
              { value: "wide", label: t("set.appearance.wide") },
              { value: "full", label: t("set.appearance.full") },
            ]}
            onChange={(v) => set({ line_width: v })}
          />
        </Row>
        <Row label={t("set.appearance.reduceMotion")} description={t("set.appearance.reduceMotionDesc")}>
          <Switch label={t("set.appearance.reduceMotion")} checked={a.reduce_motion} onChange={(v) => set({ reduce_motion: v })} />
        </Row>
        <Row label={t("set.appearance.startup")} description={t("set.appearance.startupDesc")}>
          <Switch label={t("set.appearance.startup")} checked={a.startup_animation} onChange={(v) => set({ startup_animation: v })} />
        </Row>
        {platform === "windows" && (
          <Row label={t("set.appearance.mica")} description={t("set.appearance.micaDesc")}>
            <Switch label={t("set.appearance.mica")} checked={a.mica} onChange={(v) => set({ mica: v })} />
          </Row>
        )}
        {platform === "windows" && (
          <Row label={t("set.appearance.titlebar")} description={t("set.appearance.titlebarDesc")}>
            <Switch label={t("set.appearance.titlebar")} checked={a.custom_titlebar} onChange={(v) => set({ custom_titlebar: v })} />
          </Row>
        )}
      </Group>
      {editing && <ThemeEditor theme={editing} themes={themes} accent={a.accent} onCancel={() => setEditing(null)} onSave={saveCustom} onExport={a.custom_themes.some((c) => c.id === editing.id) ? exportCustom : undefined} />}
    </>
  );
}

/** A name no other theme has: „Papier“, „Papier 2“, … */
function uniqueName(name: string, themes: ThemeDef[]): string {
  const base = name.trim() || "Eigenes Thema";
  const taken = new Set(themes.map((d) => d.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
}

function AccentRow({ a, set, light, dark, shown }: { a: AppearancePrefs; set: (p: Partial<AppearancePrefs>) => void; light: ThemeDef; dark: ThemeDef; shown: ThemeDef }) {
  const t = useT();
  const hex = effectiveAccent(shown, a.accent);
  const [custom, setCustom] = useState(accentHex(a.accent) ?? hex);
  useEffect(() => setCustom(accentHex(a.accent) ?? hex), [a.accent, hex]);
  const commitCustom = (v: string) => {
    const h = accentHex(v);
    if (h && h !== accentHex(a.accent)) set({ accent: h });
  };
  const tokens = (def: ThemeDef) => accentTokens(effectiveAccent(def, a.accent), def.dark ? "dark" : "light", def.colors.background);
  const ratio = (def: ThemeDef) => contrast(tokens(def)["--accent-text"], def.colors.background).toFixed(1).replace(".", ",");
  const now = tokens(shown);
  const fixed = !!shown.fixedAccent;
  return (
    <Row stack label={t("set.appearance.accent")} description={fixed ? t("set.appearance.accentFixed") : t("set.appearance.accentDesc")}>
      <div className="accent-swatches" role="group" aria-label={t("set.appearance.accent")}>
        <button
          type="button"
          className={`accent-swatch accent-theme ${a.accent === "theme" ? "on" : ""}`}
          style={{ background: shown.colors.accent }}
          aria-pressed={a.accent === "theme"}
          aria-label={t("accent.theme")}
          data-accent="theme"
          data-tooltip={t("accent.theme")}
          disabled={fixed}
          onClick={() => set({ accent: "theme" })}
        >
          {a.accent === "theme" ? <Check size={14} strokeWidth={2.5} /> : <Palette size={13} strokeWidth={2} />}
        </button>
        <span className="accent-sep" aria-hidden />
        {ACCENT_PRESETS.map((p) => {
          const on = a.accent === p.id || (a.accent.startsWith("#") && a.accent === p.hex);
          return (
            <button
              key={p.id}
              type="button"
              className={`accent-swatch ${on ? "on" : ""}`}
              style={{ background: p.hex }}
              aria-pressed={on}
              aria-label={t(`accent.${p.id}` as TKey)}
              data-accent={p.id}
              data-tooltip={t(`accent.${p.id}` as TKey)}
              disabled={fixed}
              onClick={() => set({ accent: p.id })}
            >
              {on && <Check size={14} strokeWidth={2.5} />}
            </button>
          );
        })}
        <label className="accent-custom" data-tooltip={t("set.appearance.customColor")}>
          <input type="color" value={custom} disabled={fixed} aria-label={t("set.appearance.customColor")} onChange={(e) => setCustom(e.target.value)} onBlur={(e) => commitCustom(e.target.value)} />
        </label>
        <Input
          className="mono w-120"
          value={custom}
          disabled={fixed}
          aria-label={t("set.appearance.hex")}
          placeholder="#6366f1"
          onChange={(e) => setCustom(e.target.value)}
          onBlur={() => commitCustom(custom)}
          onKeyDown={(e) => e.key === "Enter" && commitCustom(custom)}
        />
      </div>
      <div className="accent-preview small">
        {/* White on --accent-strong, like the primary buttons (the accent tokens guarantee 4.5:1). */}
        <span className="accent-chip" style={{ background: now["--accent-strong"], color: "#fff" }}>
          {t("set.appearance.button")}
        </span>
        <span style={{ color: now["--accent-text"] }}>{t("set.appearance.link")}</span>
        <span className="faint">{t("set.appearance.contrast", { light: ratio(light), dark: ratio(dark) })}</span>
      </div>
    </Row>
  );
}

