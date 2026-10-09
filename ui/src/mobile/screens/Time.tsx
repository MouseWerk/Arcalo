// „Zeit“: the timer, a booking with the desktop's `/zeit` syntax (the references booked last
// first), and this week's bookings per day.

import { useEffect, useMemo, useState } from "react";
import { Clock, Info, Pause, Play, Square, Trash2 } from "lucide-react";
import { api } from "../../lib/api";
import { dateShort, time } from "../../lib/format";
import { t } from "../../lib/i18n";
import type { ProjectTree, TimeEntryRow, TimerStatus } from "../../lib/types";
import { mobileApi, type RecentTarget } from "../api";
import { errorText, useMobile } from "../context";
import { bookingDays, entryReference, hours, weekEntries, zeitLine, type ZeitDraft } from "../model";
import { Empty, Field, Header, Notice, Section, Segmented, Spinner } from "../ui";

export function TimeScreen() {
  const m = useMobile();
  const on = m.settings.time?.enabled !== false;
  const [rows, setRows] = useState<TimeEntryRow[] | null>(null);
  const [timer, setTimer] = useState<TimerStatus | null>(null);

  useEffect(() => {
    if (!on) return;
    let live = true;
    const from = new Date();
    from.setDate(from.getDate() - 8);
    api.entries(from.toISOString()).then((r) => live && setRows(r)).catch((e) => m.toast("error", errorText(e)));
    api.timerStatus().then((s) => live && setTimer(s)).catch(() => {});
    return () => {
      live = false;
    };
  }, [m.version, on]); // eslint-disable-line react-hooks/exhaustive-deps

  const days = useMemo(() => (rows ? weekEntries(rows, new Date(), m.settings.time?.week_start === "sunday" ? 0 : 1) : []), [rows, m.settings.time?.week_start]);

  if (!on) {
    return (
      <div className="m-screen">
        <Header title={t("mob.time.title")} />
        <div className="m-scroll">
          <Empty icon={<Clock size={28} />} text={t("mob.time.off")} />
        </div>
      </div>
    );
  }
  return (
    <div className="m-screen">
      <Header title={t("mob.time.title")} />
      <div className="m-scroll">
        {timer && <TimerCard timer={timer} />}
        <Section title={t("mob.time.newBooking")}>
          <ZeitForm withTimer={!timer} />
        </Section>
        <Section title={t("mob.time.weekList")} flush>
          {!rows ? (
            <div className="m-loading">
              <Spinner />
            </div>
          ) : days.length === 0 ? (
            <div className="m-card-empty">
              <p>{t("mob.time.noEntries")}</p>
            </div>
          ) : (
            days.map((d) => (
              <div key={d.day} className="m-day">
                <div className="m-day-head">
                  <span>{dateShort(`${d.day}T12:00:00`)}</span>
                  <span className="num">{hours(d.minutes)}</span>
                </div>
                <ul className="m-list">
                  {d.rows.map((r) => (
                    <EntryRow key={r.id} row={r} />
                  ))}
                </ul>
              </div>
            ))
          )}
        </Section>
        <p className="m-footnote">{t("mob.time.travel")}</p>
      </div>
    </div>
  );
}

function EntryRow({ row }: { row: TimeEntryRow }) {
  const m = useMobile();
  const [confirm, setConfirm] = useState(false);
  const remove = () => {
    if (!confirm) {
      setConfirm(true);
      window.setTimeout(() => setConfirm(false), 3000);
      return;
    }
    api
      .deleteEntry(row.id)
      .then(() => m.refresh())
      .catch((e) => m.toast("error", t("common.deleteFailed"), errorText(e)));
  };
  return (
    <li className="m-entry">
      <span className="m-entry-time num">{time(row.start_time)}</span>
      <span className="m-row-main">
        <span className="m-row-title">{entryReference(row)}</span>
        {(row.description || row.leistungsart) && <span className="m-row-sub">{[row.leistungsart, row.description].filter(Boolean).join(" · ")}</span>}
      </span>
      <span className="m-entry-dur num">{hours(row.duration_minutes ?? 0)}</span>
      <button type="button" className={confirm ? "m-icon-btn m-danger" : "m-icon-btn m-icon-btn-quiet"} aria-label={confirm ? t("common.confirm") : t("common.delete")} onClick={remove}>
        <Trash2 size={18} />
      </button>
    </li>
  );
}

function TimerCard({ timer }: { timer: TimerStatus }) {
  const m = useMobile();
  const [, setTick] = useState(0);
  const paused = !!timer.paused_since;
  useEffect(() => {
    if (paused) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [paused]);
  const end = paused ? new Date(timer.paused_since as string).getTime() : Date.now();
  const seconds = Math.max(0, Math.floor((end - new Date(timer.entry.start_time).getTime()) / 1000) - (timer.paused_seconds ?? 0));
  const clock = `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  const [reference, setReference] = useState("");
  useEffect(() => {
    api
      .wbs()
      .then((tree) => {
        const np = tree.flatMap((p) => p.netzplaene).find((n) => n.id === timer.entry.netzplan_id);
        if (np) setReference(timer.entry.vorgang_nr ? `${np.netzplan_nr}/${timer.entry.vorgang_nr}` : np.netzplan_nr);
      })
      .catch(() => {});
  }, [timer.entry.netzplan_id, timer.entry.vorgang_nr]);
  const run = (f: () => Promise<unknown>) => () =>
    void f()
      .then(() => m.refresh())
      .catch((e) => m.toast("error", errorText(e)));
  return (
    <section className="m-section">
      <div className="m-card m-timer-card">
        <div className="m-eyebrow">{paused ? t("mob.today.timerPaused") : t("mob.today.timerRunning")}</div>
        <div className="m-timer-clock num">{clock}</div>
        <div className="m-row-sub">{[reference, timer.entry.leistungsart, timer.entry.description].filter(Boolean).join(" · ")}</div>
        <div className="m-timer-actions">
          <button type="button" className="m-btn" onClick={run(() => api.timerPause(!paused))}>
            {paused ? <Play size={18} /> : <Pause size={18} />}
            {paused ? t("mob.time.resume") : t("mob.time.pause")}
          </button>
          <button
            type="button"
            className="m-btn m-btn-primary"
            onClick={run(async () => {
              const done = await mobileApi.timerStop();
              const minutes = done.reduce((n, e) => n + (e.duration_minutes ?? 0), 0);
              if (done.length && !minutes) m.toast("info", t("mob.time.clockBack"));
              else m.toast(done.length ? "success" : "info", done.length ? t("mob.time.stopped", { time: hours(minutes), ref: reference }) : t("mob.time.tooShort"));
            })}
          >
            <Square size={16} />
            {t("mob.time.stop")}
          </button>
          <button type="button" className="m-btn m-btn-quiet" onClick={run(() => api.timerDiscard())}>
            {t("mob.time.discard")}
          </button>
        </div>
      </div>
    </section>
  );
}

/** The booking form: reference (the last ones as chips, the Netzpläne and Vorgänge as
 *  suggestions), duration, Leistungsart, description and day; it writes a `/zeit` line. */
export function ZeitForm({ onBooked, withTimer = false }: { onBooked?: () => void; withTimer?: boolean }) {
  const m = useMobile();
  const days = bookingDays();
  const [draft, setDraft] = useState<ZeitDraft>({ reference: "", duration: "", la: "", text: "", date: days.today });
  const [recent, setRecent] = useState<RecentTarget[]>([]);
  const [tree, setTree] = useState<ProjectTree[] | null>(null);
  const [las, setLas] = useState<[string, string][]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    mobileApi.recentTargets().then(setRecent).catch(() => {});
    api.wbs().then(setTree).catch(() => setTree([]));
    api.leistungsarten().then(setLas).catch(() => {});
  }, [m.version]);

  const references = useMemo(
    () =>
      (tree ?? []).flatMap((p) =>
        p.netzplaene.flatMap((n) => [
          { value: n.netzplan_nr, label: n.description || p.name },
          ...n.vorgaenge.map((v) => ({ value: `${n.netzplan_nr}/${v.vorgang_nr}`, label: v.description || n.description })),
        ]),
      ),
    [tree],
  );
  const line = zeitLine(draft, days.today);
  const set = (patch: Partial<ZeitDraft>) => setDraft((d) => ({ ...d, ...patch }));

  const book = async () => {
    if (!line) {
      m.toast("info", t("mob.time.missing"));
      return;
    }
    setBusy(true);
    try {
      const out = await mobileApi.book(line);
      m.toast("success", t("mob.time.booked", { time: hours(out.entry.duration_minutes ?? 0), ref: out.reference }));
      setDraft({ reference: draft.reference, duration: "", la: draft.la, text: "", date: days.today });
      m.refresh();
      onBooked?.();
    } catch (e) {
      m.toast("error", t("mob.time.failed"), errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const startTimer = async () => {
    const [nr, vorgang] = draft.reference.trim().split("/");
    const np = (tree ?? []).flatMap((p) => p.netzplaene).find((n) => n.netzplan_nr.toLowerCase() === (nr ?? "").toLowerCase());
    if (!np) {
      m.toast("info", t("mob.time.missing"));
      return;
    }
    try {
      await api.timerStart(np.id, vorgang || null, draft.la || null, draft.text.trim());
      m.refresh();
    } catch (e) {
      m.toast("error", errorText(e));
    }
  };

  if (tree && tree.length === 0) {
    return (
      <Notice tone="info" icon={<Info size={18} />}>
        {t("mob.time.noWbs")}
      </Notice>
    );
  }
  return (
    <div className="m-zeit">
      {recent.length > 0 && (
        <div className="m-field">
          <div className="m-field-label">{t("mob.time.recent")}</div>
          <div className="m-chips m-chips-scroll">
            {recent.map((r) => (
              <button
                key={`${r.reference}|${r.leistungsart ?? ""}`}
                type="button"
                className={draft.reference === r.reference && draft.la === (r.leistungsart ?? "") ? "m-chip-btn on" : "m-chip-btn"}
                onClick={() => set({ reference: r.reference, la: r.leistungsart ?? "" })}
              >
                <span className="m-chip-main">{r.reference}</span>
                {r.label && <span className="m-chip-sub">{r.label}</span>}
              </button>
            ))}
          </div>
        </div>
      )}
      <Field label={t("mob.time.reference")} htmlFor="m-zeit-ref">
        <input id="m-zeit-ref" className="m-input" list="m-zeit-refs" autoCapitalize="characters" autoCorrect="off" spellCheck={false} value={draft.reference} placeholder={t("mob.time.referencePlaceholder")} onChange={(e) => set({ reference: e.target.value })} />
        <datalist id="m-zeit-refs">
          {references.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </datalist>
      </Field>
      <div className="m-field-pair">
        <Field label={t("mob.time.duration")} htmlFor="m-zeit-dur">
          <input id="m-zeit-dur" className="m-input num" inputMode="decimal" value={draft.duration} placeholder={t("mob.time.durationPlaceholder")} onChange={(e) => set({ duration: e.target.value })} />
        </Field>
        <Field label={t("mob.time.la")} htmlFor="m-zeit-la">
          <select id="m-zeit-la" className="m-input" value={draft.la} onChange={(e) => set({ la: e.target.value })}>
            <option value="">{t("mob.time.laDefault")}</option>
            {las.map(([code, desc]) => (
              <option key={code} value={code}>
                {desc ? `${code} · ${desc}` : code}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label={t("mob.time.text")} htmlFor="m-zeit-text">
        <input id="m-zeit-text" className="m-input" value={draft.text} onChange={(e) => set({ text: e.target.value })} />
      </Field>
      <div className="m-field">
        <div className="m-field-label">{t("mob.time.day")}</div>
        <Segmented
          label={t("mob.time.day")}
          value={draft.date === days.yesterday ? "yesterday" : "today"}
          onChange={(v) => set({ date: v === "yesterday" ? days.yesterday : days.today })}
          options={[
            { value: "today", label: t("mob.time.today") },
            { value: "yesterday", label: t("mob.time.yesterday") },
          ]}
        />
      </div>
      {line && (
        <div className="m-line" aria-label={t("mob.time.line")}>
          <code>{line}</code>
        </div>
      )}
      <div className="m-form-actions">
        {withTimer && (
          <button type="button" className="m-btn" disabled={!draft.reference.trim()} onClick={() => void startTimer()}>
            <Play size={18} />
            {t("mob.time.start")}
          </button>
        )}
        <button type="button" className="m-btn m-btn-primary" disabled={busy || !line} onClick={() => void book()}>
          {t("mob.time.book")}
        </button>
      </div>
    </div>
  );
}
