// Settings → Darstellung: color scheme, accent color, fonts, UI scale, density, line width,
// reduced motion and (Windows 11) the Mica backdrop. Changes apply and save immediately.

import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { Input, Segmented, Select, Switch } from "../../components/ui";
import { api } from "../../lib/api";
import { ACCENT_PRESETS, accentHex, accentTokens, contrast } from "../../lib/color";
import { useT, type TKey } from "../../lib/i18n";
import type { AppearancePrefs } from "../../lib/types";
import { Group, Row, SectionHead, type SectionProps } from "./common";

export function AppearanceSection({ draft, update }: SectionProps) {
  const t = useT();
  const a = draft.appearance;
  const set = (p: Partial<AppearancePrefs>) => update({ appearance: { ...a, ...p } });
  const [platform, setPlatform] = useState<string | null>(null);
  useEffect(() => {
    api.appInfo().then((i) => setPlatform(i.platform), () => setPlatform(null));
  }, []);
  const hex = accentHex(a.accent) ?? "#6366f1";
  const [custom, setCustom] = useState(hex);
  useEffect(() => setCustom(hex), [hex]);
  const commitCustom = (v: string) => {
    const h = accentHex(v);
    if (h && h !== hex) set({ accent: h });
  };
  const light = accentTokens(hex, "light");
  const dark = accentTokens(hex, "dark");
  // The preview sits on the current theme's background, so it shows that theme's tokens.
  const shown = document.documentElement.dataset.theme === "light" ? light : dark;
  const ratio = (fg: string, bg: string) => contrast(fg, bg).toFixed(1).replace(".", ",");

  return (
    <>
      <SectionHead title={t("set.appearance.title")} intro={t("set.appearance.intro")} />
      <Group title={t("set.appearance.scheme")}>
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
        <Row stack label={t("set.appearance.accent")} description={t("set.appearance.accentDesc")}>
          <div className="accent-swatches" role="group" aria-label={t("set.appearance.accent")}>
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
                  onClick={() => set({ accent: p.id })}
                >
                  {on && <Check size={14} strokeWidth={2.5} />}
                </button>
              );
            })}
            <label className="accent-custom" data-tooltip={t("set.appearance.customColor")}>
              <input type="color" value={hex} aria-label={t("set.appearance.customColor")} onChange={(e) => setCustom(e.target.value)} onBlur={(e) => commitCustom(e.target.value)} />
            </label>
            <Input
              className="mono w-120"
              value={custom}
              aria-label={t("set.appearance.hex")}
              placeholder="#6366f1"
              onChange={(e) => setCustom(e.target.value)}
              onBlur={() => commitCustom(custom)}
              onKeyDown={(e) => e.key === "Enter" && commitCustom(custom)}
            />
          </div>
          <div className="accent-preview small">
            <span className="accent-chip" style={{ background: shown["--accent-strong"], color: "#fff" }}>
              {t("set.appearance.button")}
            </span>
            <span style={{ color: shown["--accent-text"] }}>{t("set.appearance.link")}</span>
            <span className="faint">
              {t("set.appearance.contrast", { light: ratio(light["--accent-text"], "#ffffff"), dark: ratio(dark["--accent-text"], "#16171a") })}
            </span>
          </div>
        </Row>
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
    </>
  );
}
