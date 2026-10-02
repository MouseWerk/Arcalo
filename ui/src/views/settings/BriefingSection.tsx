// Settings → Briefing: when the Morgen-Briefing shows up by itself (off, with the first start of
// a workday, or as a notification) and its sections (switches and order). The section editor is
// also the gear panel on the briefing itself.

import { ArrowDown, ArrowUp, CalendarRange, Clock, ListChecks, Sparkles, Sun, Ticket, type LucideIcon } from "lucide-react";
import { Button, IconButton, Segmented, Switch } from "../../components/ui";
import { t as tr, useT, type TKey } from "../../lib/i18n";
import { briefingSettings, moveSection, openBriefing, toggleSection } from "../../lib/briefing";
import { timeTrackingOn } from "../../lib/timetracking";
import type { BriefingMode, BriefingSection as Section, BriefingSectionId, BriefingSettings, Settings } from "../../lib/types";
import { CommitInput, Group, Row, SectionHead, type SectionProps } from "./common";
import { checkTime } from "../../lib/settingsApply";

export const SECTION_LABEL: Record<BriefingSectionId, TKey> = {
  ai: "brief.s.ai",
  meetings: "brief.s.meetings",
  tasks: "brief.s.tasks",
  jira: "brief.s.jira",
  time: "brief.s.time",
};

export const SECTION_ICON: Record<BriefingSectionId, LucideIcon> = {
  ai: Sparkles,
  meetings: CalendarRange,
  tasks: ListChecks,
  jira: Ticket,
  time: Clock,
};

/** Switches and order of the sections; `unavailable` explains sections that cannot show now. */
export function SectionsEditor({ value, onChange, unavailable }: { value: Section[]; onChange: (v: Section[]) => void; unavailable: Partial<Record<BriefingSectionId, string>> }) {
  const t = useT();
  return (
    <ol className="bf-sections" aria-label={t("brief.sections")}>
      {value.map((s, i) => {
        const Icon = SECTION_ICON[s.id];
        const label = t(SECTION_LABEL[s.id]);
        const why = unavailable[s.id];
        return (
          <li key={s.id} className={`bf-section-item ${s.on ? "" : "off"}`} data-section={s.id}>
            <Icon size={14} aria-hidden className="bf-section-icon" />
            <span className="bf-section-name">
              {label}
              {why && <span className="faint small"> · {why}</span>}
            </span>
            <IconButton icon={ArrowUp} size="sm" label={t("common.up")} disabled={i === 0} onClick={() => onChange(moveSection(value, s.id, -1))} />
            <IconButton icon={ArrowDown} size="sm" label={t("common.down")} disabled={i === value.length - 1} onClick={() => onChange(moveSection(value, s.id, 1))} />
            <Switch label={label} checked={s.on} onChange={(on) => onChange(toggleSection(value, s.id, on))} />
          </li>
        );
      })}
    </ol>
  );
}

/** Why a section does not show with these settings. */
export function unavailableSections(s: Settings | null | undefined): Partial<Record<BriefingSectionId, string>> {
  const out: Partial<Record<BriefingSectionId, string>> = {};
  if (!s?.jira?.sites.length) out.jira = tr("brief.noJira");
  if (!timeTrackingOn(s)) out.time = tr("brief.noTime");
  return out;
}

export function BriefingSection({ draft, update }: SectionProps) {
  const t = useT();
  const b = briefingSettings(draft.briefing);
  const set = (p: Partial<BriefingSettings>) => update({ briefing: { ...b, ...p } });
  const modes: { value: BriefingMode; label: string }[] = [
    { value: "off", label: t("brief.mode.off") },
    { value: "start", label: t("brief.mode.start") },
    { value: "notify", label: t("brief.mode.notify") },
  ];
  return (
    <>
      <SectionHead title={t("brief.title")} intro={t("brief.intro")} />
      <Group title={t("brief.when")} description={t("brief.whenDesc")}>
        <Row label={t("brief.mode")} description={t(`brief.mode.${b.mode}Desc` as TKey)}>
          <Segmented value={b.mode} options={modes} onChange={(mode) => set({ mode })} label={t("brief.mode")} />
        </Row>
        {b.mode === "notify" && (
          <Row label={t("brief.time")} description={t("brief.timeDesc")}>
            <CommitInput className="time-input num bf-notify-time" value={b.notify_time} maxLength={5} placeholder="08:30" onCommit={(v) => set({ notify_time: v })} validate={(v) => (v && checkTime(v) ? t("settings.err.time") : null)} aria-label={t("brief.time")} />
          </Row>
        )}
        <Row label={t("brief.openNow")} description={t("brief.openNowDesc")}>
          <Button size="sm" icon={Sun} onClick={() => openBriefing()}>
            {t("brief.open")}
          </Button>
        </Row>
      </Group>
      <Group title={t("brief.sections")} description={t("brief.sectionsDesc")}>
        <SectionsEditor value={b.sections} onChange={(sections) => set({ sections })} unavailable={unavailableSections(draft)} />
      </Group>
    </>
  );
}
