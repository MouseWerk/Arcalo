// Settings → Ordner & Ablage: per kind of page the folder and the date subfolders (with an
// example path), the ordered rules („wenn … → Ordner“) and „Seite testen“ with the unsaved rules.

import { useState } from "react";
import { ArrowDown, ArrowUp, FlaskConical, Plus, Trash2 } from "lucide-react";
import { Button, IconButton, Input, Switch } from "../../components/ui";
import { Select } from "../../components/Select";
import { api } from "../../lib/api";
import { currentLang, useT, type TKey } from "../../lib/i18n";
import {
  FILE_TYPES,
  filingApi,
  typeFiling,
  type FileType,
  type FilingPreview,
  type FilingRule,
  type FilingSettings,
  type Granularity,
  type RuleKind,
} from "../../lib/filing";
import { CommitInput, Group, Row, StatusNote, type SectionProps } from "./common";

const RULE_KINDS: RuleKind[] = ["tag", "property", "jira", "netzplan", "title"];
const GRANULARITIES: Granularity[] = ["none", "year", "month", "week"];

/** `10 – Oktober` in the display language (as the core names the folder). */
export function monthFolder(month: number, lang = currentLang()): string {
  const name = new Intl.DateTimeFormat(lang === "de" ? "de-DE" : "en-US", { month: "long" }).format(new Date(2026, month - 1, 15));
  return `${String(month).padStart(2, "0")} – ${name}`;
}

/** ISO week number and its year. */
export function isoWeek(d: Date): { year: number; week: number } {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const start = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return { year: t.getUTCFullYear(), week: Math.ceil(((t.getTime() - start.getTime()) / 86400000 + 1) / 7) };
}

/** The example path of a kind: `Journal / 2026 / 10 – Oktober`. */
export function examplePath(root: string, granularity: Granularity, group: string | null, date: Date, weekLabel: (n: string) => string): string {
  const parts = root ? root.split("/").map((p) => p.trim()).filter(Boolean) : [];
  if (group) parts.push(group);
  if (granularity === "year" || granularity === "month") parts.push(String(date.getFullYear()));
  if (granularity === "month") parts.push(monthFolder(date.getMonth() + 1));
  if (granularity === "week") {
    const w = isoWeek(date);
    parts.push(String(w.year), weekLabel(String(w.week).padStart(2, "0")));
  }
  return parts.join(" / ");
}

export function FilingSection({ draft, update }: SectionProps) {
  const t = useT();
  const filing: FilingSettings = { types: {}, rules: [], ...draft.filing };
  const set = (f: Partial<FilingSettings>) => update({ filing: { ...filing, ...f } });
  const defaults: Record<FileType, string> = {
    journal: "Journal",
    meeting: t("fl.default.meeting"),
    voice: t("fl.default.voice"),
    jira: "Jira",
    mail: draft.mail?.notes_parent ?? "",
    bookmarks: t("fl.default.bookmarks"),
    inbox: "",
  };
  const folderOf = (k: FileType) => (k === "journal" ? draft.notes.daily_folder : k === "mail" ? (draft.mail?.notes_parent ?? "") : (typeFiling(filing, k).folder ?? ""));
  const setFolder = (k: FileType, v: string) => {
    if (k === "journal") update({ notes: { ...draft.notes, daily_folder: v || "Journal" } });
    else if (k === "mail") update({ mail: { ...draft.mail, notes_parent: v || defaults.mail } });
    else set({ types: { ...filing.types, [k]: { ...typeFiling(filing, k), folder: v } } });
  };
  const setGranularity = (k: FileType, g: Granularity) => set({ types: { ...filing.types, [k]: { ...typeFiling(filing, k), granularity: g } } });

  const rules = filing.rules;
  const setRule = (i: number, r: Partial<FilingRule>) => set({ rules: rules.map((x, j) => (j === i ? { ...x, ...r } : x)) });
  const moveRule = (i: number, d: -1 | 1) => {
    const next = [...rules];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    set({ rules: next });
  };
  const addRule = () => {
    const used = new Set(rules.map((r) => r.id));
    let n = rules.length + 1;
    while (used.has(`r${n}`)) n++;
    set({ rules: [...rules, { id: `r${n}`, kind: "tag", key: "", value: "", folder: "", enabled: true }] });
  };

  const [probe, setProbe] = useState("");
  const [result, setResult] = useState<{ preview?: FilingPreview; missing?: string } | null>(null);
  const test = async () => {
    const title = probe.trim();
    if (!title) return;
    const page = await api.resolvePage(title, false).catch(() => null);
    if (!page) return setResult({ missing: title });
    try {
      setResult({ preview: await filingApi.preview(page.id, filing) });
    } catch {
      setResult({ missing: title });
    }
  };
  const now = new Date();
  const weekLabel = (n: string) => t("fl.week", { n });

  return (
    <>
      <Group title={t("fl.set.typesTitle")} description={t("fl.set.typesDesc")}>
        {FILE_TYPES.map((k) => {
          const cfg = typeFiling(filing, k);
          const root = folderOf(k).trim() || defaults[k];
          const group = k === "jira" ? t("fl.set.exampleProject") : k === "meeting" && cfg.granularity === "series" ? t("fl.set.exampleSeries") : null;
          const path = examplePath(root, cfg.granularity === "series" ? "none" : cfg.granularity, group, now, weekLabel) || t("fl.topLevel");
          const options = (k === "meeting" ? [...GRANULARITIES, "series" as const] : GRANULARITIES).map((g) => ({ value: g, label: t(`fl.gran.${g}` as TKey) }));
          return (
            <Row key={k} label={t(`fl.type.${k}` as TKey)} description={t("fl.set.example", { path })}>
              <div className="filing-type" data-type={k}>
                <CommitInput
                  value={folderOf(k)}
                  placeholder={defaults[k] || t("fl.topLevel")}
                  aria-label={`${t(`fl.type.${k}` as TKey)}: ${t("fl.set.folder")}`}
                  onCommit={(v) => setFolder(k, v)}
                />
                <Select
                  value={cfg.granularity}
                  onChange={(e) => setGranularity(k, e.target.value as Granularity)}
                  aria-label={`${t(`fl.type.${k}` as TKey)}: ${t("fl.set.granularity")}`}
                  options={options}
                />
              </div>
            </Row>
          );
        })}
      </Group>

      <Group title={t("fl.set.rulesTitle")} description={t("fl.set.rulesDesc")}>
        <div className="filing-rules" role="list">
          {rules.length === 0 && <div className="filing-empty">{t("fl.rule.none")}</div>}
          {rules.map((r, i) => (
            <div key={r.id || i} className={`filing-rule ${r.enabled ? "" : "off"}`} role="listitem" data-rule={i + 1}>
              <span className="filing-rule-n">{i + 1}</span>
              <Select
                value={r.kind}
                onChange={(e) => setRule(i, { kind: e.target.value as RuleKind })}
                aria-label={`${t("fl.rule.n", { n: i + 1 })}: ${t("fl.rule.kind")}`}
                options={RULE_KINDS.map((k) => ({ value: k, label: t(`fl.rule.kind.${k}` as TKey) }))}
              />
              <CommitInput
                className="filing-rule-key"
                value={r.key}
                placeholder={t(`fl.rule.ph.${r.kind}` as TKey)}
                aria-label={`${t("fl.rule.n", { n: i + 1 })}: ${t("fl.rule.key")}`}
                onCommit={(v) => setRule(i, { key: v })}
              />
              {r.kind === "property" && (
                <CommitInput
                  className="filing-rule-value"
                  value={r.value}
                  placeholder={t("fl.rule.ph.value")}
                  aria-label={`${t("fl.rule.n", { n: i + 1 })}: ${t("fl.rule.ph.value")}`}
                  onCommit={(v) => setRule(i, { value: v })}
                />
              )}
              <span className="filing-rule-arrow" aria-hidden>
                →
              </span>
              <CommitInput
                className="filing-rule-folder"
                value={r.folder}
                placeholder={t("fl.rule.ph.folder")}
                aria-label={`${t("fl.rule.n", { n: i + 1 })}: ${t("fl.rule.folder")}`}
                onCommit={(v) => setRule(i, { folder: v })}
              />
              <Switch checked={r.enabled} onChange={(v) => setRule(i, { enabled: v })} label={t("fl.rule.enabled")} />
              <IconButton icon={ArrowUp} size="sm" label={t("fl.rule.up")} disabled={i === 0} onClick={() => moveRule(i, -1)} />
              <IconButton icon={ArrowDown} size="sm" label={t("fl.rule.down")} disabled={i === rules.length - 1} onClick={() => moveRule(i, 1)} />
              <IconButton icon={Trash2} size="sm" label={t("fl.rule.remove")} onClick={() => set({ rules: rules.filter((_, j) => j !== i) })} />
            </div>
          ))}
        </div>
        <div className="filing-actions">
          <Button size="sm" icon={Plus} onClick={addRule} className="filing-add">
            {t("fl.rule.add")}
          </Button>
        </div>
      </Group>

      <Group title={t("fl.test.title")} description={t("fl.test.desc")}>
        <Row label={t("fl.test.page")}>
          <div className="filing-test">
            <Input value={probe} onChange={(e) => setProbe(e.target.value)} onKeyDown={(e) => e.key === "Enter" && test()} aria-label={t("fl.test.page")} placeholder={t("fl.test.page")} />
            <Button size="sm" icon={FlaskConical} onClick={test} disabled={!probe.trim()}>
              {t("fl.test.run")}
            </Button>
          </div>
        </Row>
        {result && (
          <div className="filing-result" role="status">
            {result.missing != null ? (
              <StatusNote tone="warning">{t("fl.test.notFound", { title: result.missing })}</StatusNote>
            ) : result.preview?.path ? (
              <StatusNote tone="success" className="filing-goes">
                {t("fl.test.goes", { path: result.preview.path })}{" "}
                {result.preview.rule
                  ? t("fl.test.byRule", { n: rules.findIndex((r) => r.id === result.preview?.rule) + 1 })
                  : result.preview.kind
                    ? t("fl.test.byType", { type: t(`fl.type.${result.preview.kind}` as TKey) })
                    : ""}
                {" · "}
                {t("fl.test.now", { path: result.preview.current || t("fl.topLevel") })}
              </StatusNote>
            ) : (
              <StatusNote tone="info">{t("fl.test.stays")}</StatusNote>
            )}
          </div>
        )}
      </Group>
    </>
  );
}
