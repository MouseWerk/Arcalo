// Theme editor (Settings → Darstellung → Eigene Themen): name, kind and the nine main colors,
// with contrast hints and a live preview built from the real controls in the theme's tokens.
// Also the small mock of a window used by the theme cards.

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, Download, FileText, Hash, Search, Star } from "lucide-react";
import { Badge, Button, Dialog, Input, Segmented, Select, Switch } from "../../components/ui";
import { parseHex, toHex } from "../../lib/color";
import { useT, type TKey } from "../../lib/i18n";
import { COLOR_KEYS, contrastChecks, customDef, withAccent, type ThemeDef } from "../../lib/themes";
import type { CustomTheme, ThemeColors } from "../../lib/types";

/** A fresh `custom-…` id (letters and digits, as the core expects). */
export function newThemeId(existing: CustomTheme[]): string {
  const taken = new Set(existing.map((c) => c.id));
  let id = "";
  do id = `custom-${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
  while (taken.has(id));
  return id;
}

/** A miniature window in the theme's colors: ribbon, sidebar with the open page, a note with a button and status dots. */
export function ThemeMock({ def }: { def: ThemeDef }) {
  const k = def.colors;
  const style = {
    "--m-app": def.app ?? k.surface,
    "--m-bg": k.background,
    "--m-surface": k.surface,
    "--m-text": k.text,
    "--m-muted": k.muted,
    "--m-border": k.border,
    "--m-accent": k.accent,
    "--m-success": k.success,
    "--m-warning": k.warning,
    "--m-danger": k.danger,
  } as React.CSSProperties;
  return (
    <span className="theme-mock" style={style} aria-hidden>
      <span className="tm-side">
        <span className="tm-item on" />
        <span className="tm-item" />
        <span className="tm-item short" />
        <span className="tm-item" />
      </span>
      <span className="tm-main">
        <span className="tm-title" />
        <span className="tm-line" />
        <span className="tm-line mid" />
        <span className="tm-line muted" />
        <span className="tm-chips">
          <span className="tm-btn" />
          <span className="tm-dot ok" />
          <span className="tm-dot warn" />
          <span className="tm-dot bad" />
        </span>
      </span>
    </span>
  );
}

export function ThemeEditor({
  theme,
  themes,
  accent,
  onCancel,
  onSave,
  onExport,
}: {
  theme: CustomTheme;
  themes: ThemeDef[];
  accent: string;
  onCancel: () => void;
  onSave: (t: CustomTheme, use: boolean) => void;
  onExport?: (t: CustomTheme) => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState<CustomTheme>(() => structuredClone(theme));
  const [raw, setRaw] = useState<ThemeColors>(() => ({ ...theme.colors }));
  useEffect(() => setRaw({ ...draft.colors }), [draft.colors]);
  const setColor = (key: keyof ThemeColors, value: string) => {
    const rgb = parseHex(value);
    if (rgb) setDraft((d) => ({ ...d, colors: { ...d.colors, [key]: toHex(rgb) } }));
  };
  const def = customDef({ ...draft, id: draft.id || "custom-preview" });
  // The preview gets the full token set on its own element: the real controls inside it show the theme.
  const tokens = useMemo(() => withAccent(def, accent), [JSON.stringify(draft), accent]); // eslint-disable-line react-hooks/exhaustive-deps
  const checks = contrastChecks(draft.colors);
  const isNew = !theme.id;
  const valid = draft.name.trim().length > 0;
  const fmt = (r: number) => r.toFixed(1).replace(".", ",");

  return (
    <Dialog
      open
      onClose={onCancel}
      width={880}
      title={t(isNew ? "set.appearance.editorNew" : "set.appearance.editorTitle")}
      description={t("set.appearance.editorDesc")}
      footer={
        <>
          {onExport && (
            <Button variant="ghost" icon={Download} onClick={() => onExport(draft)} className="theme-editor-export">
              {t("set.appearance.exportTheme")}
            </Button>
          )}
          <Button variant="ghost" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          {!isNew && (
            <Button onClick={() => onSave({ ...draft, name: draft.name.trim() }, false)} disabled={!valid}>
              {t("common.save")}
            </Button>
          )}
          <Button variant="primary" onClick={() => onSave({ ...draft, name: draft.name.trim() }, true)} disabled={!valid}>
            {t("set.appearance.saveAndUse")}
          </Button>
        </>
      }
    >
      <div className="theme-editor">
        <div className="theme-editor-fields">
          <label className="field">
            <span className="field-label">{t("set.appearance.themeName")}</span>
            <Input value={draft.name} maxLength={60} onChange={(e) => setDraft({ ...draft, name: e.target.value })} aria-label={t("set.appearance.themeName")} data-autofocus />
          </label>
          <div className="theme-editor-row">
            <div className="field">
              <span className="field-label">{t("set.appearance.themeKind")}</span>
              <Segmented
                label={t("set.appearance.themeKind")}
                value={draft.dark ? "dark" : "light"}
                options={[
                  { value: "light", label: t("set.appearance.light") },
                  { value: "dark", label: t("set.appearance.dark") },
                ]}
                onChange={(v) => setDraft({ ...draft, dark: v === "dark" })}
              />
            </div>
            <div className="field grow">
              <span className="field-label">{t("set.appearance.startFrom")}</span>
              <Select
                aria-label={t("set.appearance.startFrom")}
                value=""
                placeholder={t("set.appearance.pickTheme")}
                options={themes.map((d, i) => ({
                  value: d.id,
                  label: d.name,
                  ...(i === 0 || themes[i - 1].custom !== d.custom ? { group: d.custom ? t("set.appearance.custom") : t("set.appearance.themes") } : {}),
                }))}
                onChange={(e) => {
                  const src = themes.find((d) => d.id === e.target.value);
                  if (src) setDraft({ ...draft, dark: src.dark, colors: { ...src.colors } });
                }}
              />
            </div>
          </div>
          <div className="theme-colors">
            {COLOR_KEYS.map((key) => {
              const check = checks.find((c) => c.key === key);
              const label = t(`color.${key}` as TKey);
              return (
                <div key={key} className="theme-color" data-color={key}>
                  <label className="theme-color-swatch" style={{ background: draft.colors[key] }} data-tooltip={label}>
                    <input type="color" value={draft.colors[key]} aria-label={`${label} (Farbwähler)`} onChange={(e) => setColor(key, e.target.value)} />
                  </label>
                  <span className="theme-color-text">
                    <span className="theme-color-label">{label}</span>
                    {check && (
                      <span className={`theme-color-contrast ${check.ok ? "ok" : "low"}`}>
                        {check.ok ? <Check size={12} aria-hidden /> : <AlertTriangle size={12} aria-hidden />}
                        {t(check.ok ? "set.appearance.contrastOk" : "set.appearance.contrastLow", { ratio: fmt(check.ratio) })}
                      </span>
                    )}
                  </span>
                  <Input
                    className="mono theme-color-hex"
                    value={raw[key]}
                    aria-label={label}
                    aria-invalid={!parseHex(raw[key])}
                    maxLength={7}
                    onChange={(e) => {
                      setRaw({ ...raw, [key]: e.target.value });
                      if (/^#[0-9a-f]{6}$/i.test(e.target.value.trim())) setColor(key, e.target.value.trim());
                    }}
                    onBlur={() => (parseHex(raw[key]) ? setColor(key, raw[key]) : setRaw({ ...raw, [key]: draft.colors[key] }))}
                  />
                </div>
              );
            })}
          </div>
        </div>
        <ThemePreview tokens={tokens} name={draft.name} />
      </div>
    </Dialog>
  );
}

/** A small working window in the edited theme: the real buttons, switch, badges and input. */
function ThemePreview({ tokens, name }: { tokens: Record<string, string>; name: string }) {
  const t = useT();
  const [on, setOn] = useState(true);
  const style = Object.fromEntries(Object.entries(tokens).map(([k, v]) => [k === "color-scheme" ? "colorScheme" : k, v])) as React.CSSProperties;
  return (
    <div className="theme-preview" style={style} role="figure" aria-label={t("set.appearance.preview")}>
      <div className="tp-side">
        <div className="tp-search">
          <Search size={12} aria-hidden /> <span>Suchen</span>
        </div>
        <div className="tp-item active">
          <FileText size={13} aria-hidden /> <span>{name || "Notiz"}</span>
        </div>
        <div className="tp-item">
          <Star size={13} aria-hidden /> <span>Favoriten</span>
        </div>
        <div className="tp-item">
          <Hash size={13} aria-hidden /> <span>Projekte</span>
        </div>
      </div>
      <div className="tp-main">
        <div className="tp-title">Wochenplanung</div>
        <p className="tp-text">
          {t("set.appearance.previewText")} <a className="tp-link">[[Jour fixe]]</a> <mark className="tp-mark">markiert</mark>
        </p>
        <p className="tp-muted">Zuletzt bearbeitet vor 5 Minuten</p>
        <div className="tp-controls">
          <Button variant="primary" size="sm">
            {t("common.save")}
          </Button>
          <Button size="sm">{t("common.cancel")}</Button>
          <Switch label={t("set.appearance.preview")} checked={on} onChange={setOn} />
        </div>
        <div className="tp-controls">
          <Badge tone="success">Gebucht</Badge>
          <Badge tone="warning">80 %</Badge>
          <Badge tone="danger">Überzogen</Badge>
          <Badge tone="accent">Neu</Badge>
        </div>
        <Input className="tp-input" placeholder="Eingabefeld" aria-label={t("set.appearance.preview")} readOnly />
      </div>
    </div>
  );
}
