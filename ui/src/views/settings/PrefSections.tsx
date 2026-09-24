// Settings sections and groups for the preferences: notes (daily notes, trash, versions),
// time tracking (week, rounding, display, exports), start, language, notifications and privacy.

import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Badge, Button, IconButton, Input, Segmented, Select, Switch } from "../../components/ui";
import { api } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { exportFileName } from "../../lib/prefs";
import { fmtHours } from "../../lib/format";
import type { NotesPrefs, NotificationPrefs, PrivacyPrefs, ProjectTree, StartPrefs, TimePrefs } from "../../lib/types";
import { CommitInput, Group, NumberInput, Row, SectionHead, Unfiltered, type SectionProps } from "./common";

// ------------------------------------------------------------------ notes

/** Daily notes, trash and version history (below the existing notes groups). */
export function NotesPrefGroups({ draft, update }: SectionProps) {
  const t = useT();
  const n = draft.notes;
  const set = (p: Partial<NotesPrefs>) => update({ notes: { ...n, ...p } });
  const sample = new Date(2026, 8, 24);
  return (
    <>
      <Group title={t("set.notes.daily")} description={t("set.notes.dailyDesc")}>
        <Row label={t("set.notes.dailyTitle")}>
          <Select value={n.daily_title} onChange={(e) => set({ daily_title: e.target.value as NotesPrefs["daily_title"] })} aria-label={t("set.notes.dailyTitle")}>
            <option value="iso">2026-09-24</option>
            <option value="de">24.09.2026</option>
            <option value="long">{`${sample.toLocaleDateString("de-DE", { weekday: "long" })}, 24.09.2026`}</option>
          </Select>
        </Row>
        <Row label={t("set.notes.dailyFolder")} description={t("set.notes.dailyFolderDesc")}>
          <CommitInput value={n.daily_folder} onCommit={(v) => set({ daily_folder: v || "Journal" })} aria-label={t("set.notes.dailyFolder")} />
        </Row>
      </Group>
      <Group title={t("set.notes.history")}>
        <Row label={t("set.notes.trashDays")} description={t("set.notes.trashDaysDesc")}>
          <div className="unit-input">
            <NumberInput min={7} max={365} value={n.trash_retention_days} onCommit={(v) => set({ trash_retention_days: v })} aria-label={t("set.notes.trashDays")} />
            <span className="faint">{t("unit.days")}</span>
          </div>
        </Row>
        <Row label={t("set.notes.versionInterval")} description={t("set.notes.versionIntervalDesc")}>
          <div className="unit-input">
            <NumberInput min={5} max={60} value={n.version_interval_minutes} onCommit={(v) => set({ version_interval_minutes: v })} aria-label={t("set.notes.versionInterval")} />
            <span className="faint">{t("unit.minutes")}</span>
          </div>
        </Row>
        <Row label={t("set.notes.maxVersions")}>
          <div className="unit-input">
            <NumberInput min={5} max={500} value={n.max_versions} onCommit={(v) => set({ max_versions: v })} aria-label={t("set.notes.maxVersions")} />
            <span className="faint">{t("unit.perPage")}</span>
          </div>
        </Row>
      </Group>
    </>
  );
}

// ------------------------------------------------------------------- time

/** Week, rounding, display and export preferences (below the existing time groups). */
export function TimePrefGroups({ draft, update }: SectionProps) {
  const t = useT();
  const tp = draft.time;
  const set = (p: Partial<TimePrefs>) => update({ time: { ...tp, ...p } });
  const r = tp.rounding;
  const [nps, setNps] = useState<string[]>([]);
  const [las, setLas] = useState<[string, string][]>([]);
  const [np, setNp] = useState("");
  const [la, setLa] = useState("");
  useEffect(() => {
    api.wbs().then((w: ProjectTree[]) => setNps(w.flatMap((p) => p.netzplaene.map((n) => n.netzplan_nr))), () => {});
    api.leistungsarten().then(setLas, () => {});
  }, []);
  const example = exportFileName(tp.export_file_pattern, { from: "2026-09-21", to: "2026-09-27", format: "sap_cats", week: 39, pernr: draft.pernr });
  return (
    <>
      <Group title={t("set.time.week")}>
        <Row label={t("set.time.weekStart")}>
          <Segmented
            label={t("set.time.weekStart")}
            value={tp.week_start}
            options={[
              { value: "monday", label: t("set.time.monday") },
              { value: "sunday", label: t("set.time.sunday") },
            ]}
            onChange={(v) => set({ week_start: v })}
          />
        </Row>
        <Row label={t("set.time.hoursDisplay")} description={t("set.time.hoursDisplayDesc")}>
          <Segmented
            label={t("set.time.hoursDisplay")}
            value={tp.hours_display}
            options={[
              { value: "decimal", label: `${fmtHours(1.5, "decimal")} h` },
              { value: "clock", label: `${fmtHours(1.5, "clock")} h` },
            ]}
            onChange={(v) => set({ hours_display: v })}
          />
        </Row>
      </Group>
      <Group title={t("set.time.rounding")} description={t("set.time.roundingDesc")}>
        <Row label={t("set.time.roundStep")}>
          <div className="unit-input">
            <Select value={String(r.step_minutes)} onChange={(e) => set({ rounding: { ...r, step_minutes: Number(e.target.value) } })} aria-label={t("set.time.roundStep")}>
              <option value="0">{t("set.time.roundOff")}</option>
              {[1, 5, 6, 10, 15].map((m) => (
                <option key={m} value={m}>
                  {m} {t("unit.min")}
                </option>
              ))}
            </Select>
            {r.step_minutes > 1 && (
              <Segmented
                label={t("set.time.roundMode")}
                value={r.mode}
                options={[
                  { value: "up", label: t("set.time.roundUp") },
                  { value: "nearest", label: t("set.time.roundNearest") },
                ]}
                onChange={(v) => set({ rounding: { ...r, mode: v } })}
              />
            )}
          </div>
        </Row>
        <Row label={t("set.time.minBooking")} description={t("set.time.minBookingDesc")}>
          <div className="unit-input">
            <NumberInput min={0} max={240} value={r.min_minutes} onCommit={(v) => set({ rounding: { ...r, min_minutes: v } })} aria-label={t("set.time.minBooking")} />
            <span className="faint">{t("unit.minutes")}</span>
          </div>
        </Row>
      </Group>
      <Group title={t("set.time.defaultLa")} description={t("set.time.defaultLaDesc")}>
        <Unfiltered>
          <div className="map-list">
            {Object.entries(tp.default_leistungsart).map(([k, v]) => (
              <div key={k} className="map-row">
                <span className="mono">{k}</span>
                <span className="faint">→</span>
                <Badge>{v}</Badge>
                <span className="grow" />
                <IconButton
                  icon={Trash2}
                  label={t("common.remove")}
                  size="sm"
                  onClick={() => {
                    const m = { ...tp.default_leistungsart };
                    delete m[k];
                    set({ default_leistungsart: m });
                  }}
                />
              </div>
            ))}
            <div className="map-row">
              <Select value={np} onChange={(e) => setNp(e.target.value)} aria-label={t("set.time.netzplan")} className="grow">
                <option value="">{t("set.time.netzplan")}</option>
                {nps.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
              <span className="faint">→</span>
              <Select value={la} onChange={(e) => setLa(e.target.value)} aria-label={t("set.time.leistungsart")} className="grow">
                <option value="">{t("set.time.leistungsart")}</option>
                {las.map(([code, desc]) => (
                  <option key={code} value={code}>
                    {code} – {desc}
                  </option>
                ))}
              </Select>
              <Button
                icon={Plus}
                disabled={!np || !la}
                onClick={() => {
                  set({ default_leistungsart: { ...tp.default_leistungsart, [np]: la } });
                  setNp("");
                  setLa("");
                }}
              >
                {t("common.add")}
              </Button>
            </div>
          </div>
        </Unfiltered>
      </Group>
      <Group title={t("set.time.export")}>
        <Row label={t("set.time.catsDelimiter")}>
          <Segmented
            label={t("set.time.catsDelimiter")}
            value={tp.cats_delimiter}
            options={[
              { value: "semicolon", label: t("set.time.semicolon") },
              { value: "comma", label: t("set.time.comma") },
              { value: "tab", label: t("set.time.tab") },
            ]}
            onChange={(v) => set({ cats_delimiter: v })}
          />
        </Row>
        <Row label={t("set.time.catsColumns")} description={t("set.time.catsColumnsDesc")}>
          <Select value={tp.cats_columns} onChange={(e) => set({ cats_columns: e.target.value as TimePrefs["cats_columns"] })} aria-label={t("set.time.catsColumns")}>
            <option value="standard">PERNR, WORKDATE, RPROJ, RNPLNR, VORNR, LSTAR, CATSHOURS, MEINH, LTXA1</option>
            <option value="without_wbs">{t("set.time.colsWithoutWbs")}</option>
            <option value="date_first">{t("set.time.colsDateFirst")}</option>
          </Select>
        </Row>
        <Row stack label={t("set.time.filePattern")} description={t("set.time.filePatternDesc", { example: `${example}.csv` })}>
          <CommitInput value={tp.export_file_pattern} onCommit={(v) => set({ export_file_pattern: v || "zeiten-{von}-{bis}" })} aria-label={t("set.time.filePattern")} className="grow mono" />
        </Row>
      </Group>
    </>
  );
}

// ------------------------------------------------------------------ start

export function StartSection({ draft, update }: SectionProps) {
  const t = useT();
  const st = draft.start;
  const set = (p: Partial<StartPrefs>) => update({ start: { ...st, ...p } });
  return (
    <>
      <SectionHead title={t("set.start.title")} intro={t("set.start.intro")} />
      <Group title={t("set.start.opens")}>
        <Row label={t("set.start.open")}>
          <Segmented
            label={t("set.start.open")}
            value={st.open}
            options={[
              { value: "tabs", label: t("set.start.tabs") },
              { value: "dashboard", label: t("set.start.dashboard") },
              { value: "daily", label: t("set.start.daily") },
            ]}
            onChange={(v) => set({ open: v })}
          />
        </Row>
      </Group>
      <Group title={t("set.start.window")}>
        <Row label={t("set.start.restore")} description={t("set.start.restoreDesc")}>
          <Switch label={t("set.start.restore")} checked={st.restore_window} onChange={(v) => set({ restore_window: v })} />
        </Row>
        <Row label={t("set.start.minimized")} description={t("set.start.minimizedDesc")}>
          <Switch label={t("set.start.minimized")} checked={st.minimized} onChange={(v) => set({ minimized: v })} />
        </Row>
      </Group>
    </>
  );
}

// ----------------------------------------------------------------- locale

export function LocaleSection({ draft, update }: SectionProps) {
  const t = useT();
  const l = draft.locale;
  return (
    <>
      <SectionHead title={t("set.locale.title")} intro={t("set.locale.intro")} />
      <Group title={t("set.locale.language")}>
        <Row label={t("set.locale.uiLanguage")} description={t("set.locale.uiLanguageDesc")}>
          <Segmented
            label={t("set.locale.uiLanguage")}
            value={l.language}
            options={[
              { value: "de", label: "Deutsch" },
              { value: "en", label: "English" },
            ]}
            onChange={(v) => update({ locale: { ...l, language: v } })}
          />
        </Row>
        <Row label={t("set.locale.dateFormat")}>
          <Segmented
            label={t("set.locale.dateFormat")}
            value={l.date_format}
            options={[
              { value: "de", label: "24.09.2026" },
              { value: "iso", label: "2026-09-24" },
            ]}
            onChange={(v) => update({ locale: { ...l, date_format: v } })}
          />
        </Row>
      </Group>
    </>
  );
}

// ---------------------------------------------------------- notifications

export function NotificationsSection({ draft, update }: SectionProps) {
  const t = useT();
  const n = draft.notifications;
  const set = (p: Partial<NotificationPrefs>) => update({ notifications: { ...n, ...p } });
  const toggle = (key: keyof NotificationPrefs & ("end_of_day" | "late_timer" | "budget" | "backup_failed" | "git_failed" | "updates"), label: string, description?: string) => (
    <Row label={label} description={description}>
      <Switch label={label} checked={n[key]} onChange={(v) => set({ [key]: v })} />
    </Row>
  );
  return (
    <>
      <SectionHead title={t("set.notify.title")} intro={t("set.notify.intro")} />
      <Group title={t("set.notify.desktop")}>
        {toggle("end_of_day", t("set.notify.endOfDay"), draft.reminder_time ? t("set.notify.endOfDayAt", { time: draft.reminder_time }) : t("set.notify.endOfDayOff"))}
        {toggle("late_timer", t("set.notify.lateTimer"), t("set.notify.lateTimerDesc"))}
      </Group>
      <Group title={t("set.notify.inApp")}>
        {toggle("budget", t("set.notify.budget"), t("set.notify.budgetDesc"))}
        {toggle("backup_failed", t("set.notify.backup"))}
        {toggle("git_failed", t("set.notify.git"))}
        {toggle("updates", t("set.notify.updates"), t("set.notify.updatesDesc"))}
      </Group>
      <Group title={t("set.notify.quiet")} description={t("set.notify.quietDesc")}>
        <Row label={t("set.notify.quietHours")}>
          <div className="unit-input">
            {n.quiet_hours && (
              <>
                <Input className="time-input num" value={n.quiet_from} maxLength={5} onChange={(e) => set({ quiet_from: e.target.value })} aria-label={t("set.notify.from")} />
                <span className="faint">–</span>
                <Input className="time-input num" value={n.quiet_to} maxLength={5} onChange={(e) => set({ quiet_to: e.target.value })} aria-label={t("set.notify.to")} />
              </>
            )}
            <Switch label={t("set.notify.quietHours")} checked={n.quiet_hours} onChange={(v) => set({ quiet_hours: v })} />
          </div>
        </Row>
      </Group>
    </>
  );
}

// ---------------------------------------------------------------- privacy

export function PrivacySection({ draft, update }: SectionProps) {
  const t = useT();
  const p = draft.privacy;
  const set = (x: Partial<PrivacyPrefs>) => update({ privacy: { ...p, ...x } });
  const router = draft.router;
  return (
    <>
      <SectionHead title={t("set.privacy.title")} intro={t("set.privacy.intro")} />
      <Group title={t("set.privacy.assistant")}>
        <Row stack label={t("set.privacy.markers")} description={t("set.privacy.markersDesc")}>
          <CommitInput
            value={router.private_markers.join(", ")}
            onCommit={(v) =>
              update({
                router: {
                  ...router,
                  private_markers: v
                    .split(",")
                    .map((x) => x.trim())
                    .filter(Boolean)
                    .map((x) => (x.startsWith("#") ? x : `#${x}`)),
                },
              })
            }
            className="grow"
            aria-label={t("set.privacy.markers")}
          />
        </Row>
        <Row label={t("set.privacy.readPage")} description={t("set.privacy.readPageDesc")}>
          <Switch label={t("set.privacy.readPage")} checked={p.read_open_page} onChange={(v) => set({ read_open_page: v })} />
        </Row>
        <Row label={t("set.privacy.localOnly")} description={t("set.privacy.localOnlyDesc", { model: router.local_model })}>
          <Switch label={t("set.privacy.localOnly")} checked={p.local_only} onChange={(v) => set({ local_only: v })} />
        </Row>
      </Group>
    </>
  );
}
