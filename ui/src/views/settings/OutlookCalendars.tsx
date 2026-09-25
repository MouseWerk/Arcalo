// Settings → Kalender → Outlook → „Kalender auswählen“: every calendar discovery found in
// Outlook Classic (default, sub-calendars, other mailboxes and PSTs, calendars shared by
// colleagues, rooms, groups) with a checkbox, color, badges and its sync status, plus people
// whose calendars are opened by name. Selections are saved by their own command at once.

import { useEffect, useState } from "react";
import { Plus, RefreshCw, Search, X } from "lucide-react";
import { api } from "../../lib/api";
import { useApp } from "../../store/app";
import { relative } from "../../lib/format";
import { Badge, Button, IconButton, Input, Switch } from "../../components/ui";
import { useT } from "../../lib/i18n";
import { CAL_COLORS, KIND_LABEL, rowStatus } from "../../lib/outlookcal";
import type { CalendarStatus, OutlookCalendarRow } from "../../lib/types";
import { StatusNote } from "./common";

/** Discovery runs by itself once per session when the section first shows. */
let autoDiscovered = false;

export function OutlookCalendars({ status, setStatus }: { status: CalendarStatus; setStatus: (s: CalendarStatus) => void }) {
  const t = useT();
  const s = useApp.getState;
  const people = useApp((x) => x.settings?.settings.calendar.outlook_recipients) ?? [];
  const [colorFor, setColorFor] = useState<string | null>(null);
  const [person, setPerson] = useState("");
  const rows = status.outlook_calendars;
  const d = status.discovery;

  const run = async (fn: () => Promise<CalendarStatus>, failTitle: string) => {
    try {
      setStatus(await fn());
      await s().refreshSettings();
    } catch (e) {
      s().error(failTitle, e);
      api.calendarStatus().then(setStatus).catch(() => {});
    }
  };
  const discover = () => run(() => api.calendarOutlookDiscover(), t("olcal.searchFailed"));
  const update = (r: OutlookCalendarRow, patch: { enabled?: boolean; color?: string; booking?: boolean }) => run(() => api.calendarOutlookUpdate(r.id, patch), t("olcal.saveFailed"));
  const setPeople = (next: string[]) => run(() => api.calendarOutlookPeople(next), t("olcal.searchFailed"));

  useEffect(() => {
    if (autoDiscovered || d.at || d.running) return;
    autoDiscovered = true;
    void discover();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addPerson = () => {
    const p = person.trim();
    if (!p) return;
    setPerson("");
    if (!people.some((x) => x.toLowerCase() === p.toLowerCase())) void setPeople([...people, p]);
  };

  return (
    <div className="olcal" aria-label={t("olcal.title")}>
      <div className="olcal-head">
        <div className="olcal-head-text">
          <div className="olcal-title">{t("olcal.title")}</div>
          <div className="olcal-desc faint">{t("olcal.desc")}</div>
        </div>
        <Button size="sm" icon={RefreshCw} loading={d.running} onClick={() => void discover()}>
          {t("olcal.search")}
        </Button>
      </div>
      <div className="olcal-found faint" role="status">
        {d.running ? t("olcal.searching") : d.error ? <span className="olcal-error">{d.error}</span> : d.at ? t("olcal.searchedAt", { n: rows.filter((r) => r.found).length, when: relative(d.at) }) : t("olcal.notSearched")}
      </div>
      <div className="olcal-list" role="list" aria-label={t("olcal.list")}>
        {rows.length === 0 && <div className="olcal-empty faint">{t("olcal.empty")}</div>}
        {rows.map((r) => {
          const name = r.name || r.owner;
          const st = rowStatus(r);
          const kind = KIND_LABEL[r.kind];
          const refused = !!r.error && !r.stored;
          return (
            <div key={r.id} role="listitem" className={`olcal-row ${r.enabled ? "on" : ""} ${refused ? "refused" : ""}`} data-calendar={r.id}>
              <input type="checkbox" className="check" checked={r.enabled} disabled={refused} aria-label={t("olcal.select", { name })} onChange={() => void update(r, { enabled: !r.enabled })} />
              <button type="button" className="olcal-swatch" style={{ background: r.color }} aria-label={t("olcal.color", { name })} aria-expanded={colorFor === r.id} onClick={() => setColorFor(colorFor === r.id ? null : r.id)} />
              <div className="olcal-text">
                <div className="olcal-name">
                  <span className="ellipsis">{name}</span>
                  {r.default && <Badge tone="info">{t("olcal.default")}</Badge>}
                  {kind && <Badge>{t(kind)}</Badge>}
                  {r.free_busy && (
                    <Badge tone="warning" title={t("olcal.freeBusyHint")}>
                      {t("olcal.freeBusy")}
                    </Badge>
                  )}
                </div>
                {(r.owner || r.path) && (
                  <div className="olcal-owner faint ellipsis" title={r.path || undefined}>
                    {r.owner || r.path}
                  </div>
                )}
                {st.text && (
                  <StatusNote tone={st.tone} className="olcal-status">
                    {st.text}
                  </StatusNote>
                )}
              </div>
              {!refused && (
                <label className="olcal-booking" data-tooltip={t("olcal.bookingHint")}>
                  <span className="faint">{t("olcal.bookingShort")}</span>
                  <Switch label={t("olcal.booking")} checked={r.booking} onChange={(v) => void update(r, { booking: v })} />
                </label>
              )}
              {colorFor === r.id && (
                <div className="olcal-colors" role="radiogroup" aria-label={t("olcal.color", { name })}>
                  {CAL_COLORS.map((c) => (
                    <button
                      type="button"
                      key={c.color}
                      role="radio"
                      aria-checked={c.color === r.color}
                      aria-label={t(c.name)}
                      data-tooltip={t(c.name)}
                      className="olcal-color"
                      style={{ background: c.color }}
                      onClick={() => {
                        setColorFor(null);
                        if (c.color !== r.color) void update(r, { color: c.color });
                      }}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="olcal-people">
        <div className="olcal-people-label">
          <Search size={13} aria-hidden />
          <span>{t("olcal.people")}</span>
        </div>
        <div className="olcal-people-add">
          <Input value={person} onChange={(e) => setPerson(e.target.value)} placeholder={t("olcal.peoplePlaceholder")} aria-label={t("olcal.people")} spellCheck={false} onKeyDown={(e) => e.key === "Enter" && addPerson()} />
          <Button icon={Plus} onClick={addPerson} disabled={!person.trim() || d.running}>
            {t("olcal.open")}
          </Button>
        </div>
        <div className="olcal-people-hint faint">{t("olcal.peopleHint")}</div>
        {people.length > 0 && (
          <div className="olcal-people-list">
            {people.map((p) => (
              <span key={p} className="olcal-person">
                {p}
                <IconButton icon={X} size="sm" label={t("olcal.removePerson", { name: p })} onClick={() => void setPeople(people.filter((x) => x !== p))} />
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
