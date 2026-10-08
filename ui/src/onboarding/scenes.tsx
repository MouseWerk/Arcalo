// The visuals of the intro: small, crisp pieces of Arcalo's own UI built from the theme tokens
// (so they follow light, dark and every color theme). Motion is CSS only (firstrun.css): each
// element starts after its `--d` delay; reduced motion shows the final state.

import type { CSSProperties, ReactNode } from "react";
import { ArrowRight, Check, CalendarRange, DatabaseBackup, FileText, GitBranch, Hash, Link2, ListChecks, Lock, NotebookPen, Sparkles, Timer, Users } from "lucide-react";
import { ArcaloLogo } from "../components/Logo";
import { t } from "../lib/i18n";
import { zeitCommand } from "../editor/zeit-suggest";
import type { TKey } from "../lib/i18n";

/** Delay of an element's entrance, in ms. */
const d = (ms: number): CSSProperties => ({ ["--d" as string]: `${ms}ms` });

function Frame({ children, className = "", label }: { children: ReactNode; className?: string; label?: string }) {
  return (
    <div className={`frv-window ${className}`}>
      <div className="frv-titlebar" aria-hidden>
        <i />
        <i />
        <i />
        {label && <span>{label}</span>}
      </div>
      <div className="frv-body">{children}</div>
    </div>
  );
}

function Task({ done, text, delay }: { done?: boolean; text: string; delay: number }) {
  return (
    <div className="frv-task frv-in" style={d(delay)}>
      <span className={`frv-check ${done ? "on" : ""}`}>{done && <Check size={10} strokeWidth={3} />}</span>
      {text}
    </div>
  );
}

/** The day in one app: a note, tasks, a meeting and the hours, as on the start page. */
export function WelcomeVisual() {
  return (
    <div className="frv-stack">
      <Frame label={t("fr.v.today")} className="frv-day">
        <div className="frv-day-grid">
          <div className="frv-tile frv-pop" style={d(200)}>
            <div className="frv-tile-head">
              <NotebookPen size={13} strokeWidth={1.9} />
              {t("fr.v.dayNote")}
            </div>
            <div className="frv-tile-title">{t("fr.v.notesTitle")}</div>
            <div className="frv-line" style={{ width: "92%" }} />
            <div className="frv-line" style={{ width: "68%" }} />
          </div>
          <div className="frv-tile frv-pop" style={d(380)}>
            <div className="frv-tile-head">
              <ListChecks size={13} strokeWidth={1.9} />
              {t("fr.v.dayTasks")}
            </div>
            <Task done text={t("fr.v.dayTask1")} delay={700} />
            <Task text={t("fr.v.dayTask2")} delay={820} />
            <Task text={t("fr.v.dayTask3")} delay={940} />
          </div>
          <div className="frv-tile frv-pop" style={d(560)}>
            <div className="frv-tile-head">
              <CalendarRange size={13} strokeWidth={1.9} />
              {t("fr.v.dayMeeting")}
            </div>
            <div className="frv-event-row">
              <span className="frv-time">10:00</span>
              <span className="frv-event-name">{t("fr.v.dayMeetingTitle")}</span>
            </div>
            <div className="frv-event-row faint">
              <span className="frv-time">14:30</span>
              <span className="frv-event-name">{t("fr.v.workshop")}</span>
            </div>
          </div>
          <div className="frv-tile frv-pop" style={d(740)}>
            <div className="frv-tile-head">
              <Timer size={13} strokeWidth={1.9} />
              {t("fr.v.dayTime")}
            </div>
            <div className="frv-hours">{t("fr.v.dayHours")}</div>
            <div className="frv-meter">
              <i className="frv-grow-x" style={d(1100)} />
            </div>
          </div>
        </div>
      </Frame>
      <span className="frv-optional frv-pop" style={d(1500)}>
        <Sparkles size={12} strokeWidth={1.9} />
        {t("fr.v.aiOptional")}
      </span>
    </div>
  );
}

export function NotesVisual() {
  return (
    <div className="frv-stack">
      <Frame label={t("fr.v.notesTab")}>
        <div className="frv-note">
          <div className="frv-h1 frv-in" style={d(150)}>
            {t("fr.v.notesTitle")}
          </div>
          <div className="frv-meta frv-in" style={d(300)}>
            <span className="frv-tag">
              <Hash size={11} strokeWidth={2.2} />
              projekt
            </span>
            <span className="frv-tag">
              <Hash size={11} strokeWidth={2.2} />
              kunde
            </span>
          </div>
          <p className="frv-p frv-in" style={d(450)}>
            {t("fr.v.notesLine1")} <span className="frv-link frv-glow" style={d(1500)}>[[{t("fr.v.notesLink")}]]</span> {t("fr.v.notesLine2")}
          </p>
          <div className="frv-line frv-in" style={{ ...d(650), width: "86%" }} />
          <Task done text={t("fr.v.notesTask1")} delay={900} />
          <Task text={t("fr.v.notesTask2")} delay={1050} />
        </div>
      </Frame>
      <div className="frv-card frv-float frv-pop" style={d(1900)}>
        <div className="frv-card-head">
          <ListChecks size={13} strokeWidth={1.9} />
          {t("fr.v.dayTasks")}
        </div>
        <div className="frv-task-row">
          <span className="frv-check" />
          <span className="grow">{t("fr.v.notesTask2")}</span>
          <span className="frv-due">{t("fr.v.due")}</span>
        </div>
        <div className="frv-backlinks">
          <Link2 size={12} strokeWidth={2} />
          {t("fr.v.backlinks")}
        </div>
      </div>
    </div>
  );
}

export function MeetingsVisual() {
  const meetings = [
    { day: 0, top: 10, h: 16, label: t("fr.v.daily") },
    { day: 1, top: 30, h: 26, label: t("fr.v.workshop"), now: true },
    { day: 2, top: 10, h: 16, label: t("fr.v.daily") },
    { day: 3, top: 52, h: 22, label: t("fr.v.review") },
    { day: 4, top: 10, h: 16, label: t("fr.v.daily") },
  ];
  const days = [t("fr.v.mo"), t("fr.v.tu"), t("fr.v.we"), t("fr.v.th"), t("fr.v.fr")];
  return (
    <div className="frv-stack">
      <Frame label={t("fr.v.calendarTab")} className="frv-cal">
        <div className="frv-cal-grid" aria-hidden>
          {days.map((x, i) => (
            <div key={i} className="frv-cal-col">
              <b>{x}</b>
              <div className="frv-cal-body">
                {meetings
                  .filter((m) => m.day === i)
                  .map((m, j) => (
                    <span key={j} className={`frv-event frv-in ${m.now ? "now" : ""}`} style={{ ...d(200 + i * 110), top: `${m.top}%`, height: `${m.h}%` }}>
                      {m.label}
                    </span>
                  ))}
              </div>
            </div>
          ))}
        </div>
      </Frame>
      <div className="frv-card frv-float frv-meeting frv-pop" style={d(1300)}>
        <div className="frv-card-head">
          <FileText size={13} strokeWidth={1.9} />
          {t("fr.v.meetTitle")}
        </div>
        <div className="frv-people">
          <Users size={12} strokeWidth={2} />
          {t("fr.v.meetPeople")}
        </div>
        <Task text={t("fr.v.meetTask")} delay={2000} />
        <span className="frv-saved frv-pop" style={d(2600)}>
          <Check size={12} strokeWidth={2.6} />
          {t("fr.v.meetCreated")}
        </span>
      </div>
    </div>
  );
}

export function TimeVisual() {
  const bars = [8, 7.5, 8.25, 5.5, 0];
  return (
    <div className="frv-stack">
      <Frame label={t("fr.v.dailyTab")}>
        <div className="frv-zeit frv-in" style={d(100)}>
          <span className="frv-zeit-cmd">{zeitCommand()}</span>
          <span className="frv-type" style={{ ...d(350), ["--n" as string]: t("fr.v.zeitLine").length }}>
            {t("fr.v.zeitLine")}
          </span>
        </div>
        <div className="frv-booked frv-pop" style={d(2100)}>
          <Check size={12} strokeWidth={2.6} />
          {t("fr.v.booked")}
        </div>
      </Frame>
      <div className="frv-card frv-week frv-in" style={d(700)}>
        <div className="frv-week-head">
          <Timer size={13} strokeWidth={1.9} />
          {t("fr.v.week")}
          <span className="frv-exports frv-pop" style={d(2900)}>
            <span className="frv-cats">SAP CATS</span>
            <span className="frv-cats">Jira</span>
            <ArrowRight size={11} strokeWidth={2.2} />
          </span>
        </div>
        <div className="frv-bars" aria-hidden>
          <span className="frv-target" />
          {bars.map((h, i) => (
            <span key={i} className="frv-bar">
              <i className="frv-grow" style={{ ...d(900 + i * 160), ["--h" as string]: `${(h / 10) * 100}%` }} />
              <b>{[t("fr.v.mo"), t("fr.v.tu"), t("fr.v.we"), t("fr.v.th"), t("fr.v.fr")][i]}</b>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

export function LocalVisual() {
  const outs: [typeof DatabaseBackup, TKey, TKey][] = [
    [DatabaseBackup, "fr.v.backups", "fr.v.backupsSub"],
    [FileText, "fr.v.markdown", "fr.v.markdownSub"],
    [GitBranch, "fr.v.git", "fr.v.gitSub"],
  ];
  return (
    <div className="frv-local">
      <div className="frv-db frv-pop" style={d(150)}>
        <span className="frv-db-icon">
          <ArcaloLogo size={22} />
        </span>
        <span className="frv-db-name">workspace.db</span>
        <span className="frv-db-sub">
          <Lock size={11} strokeWidth={2.2} />
          {t("fr.v.onThisPc")}
        </span>
      </div>
      <svg className="frv-wires" viewBox="0 0 300 120" preserveAspectRatio="none" aria-hidden>
        {[50, 150, 250].map((x, i) => (
          <path key={x} className="frv-wire" style={d(700 + i * 200)} pathLength={1} d={`M150 0 C150 60 ${x} 50 ${x} 120`} />
        ))}
      </svg>
      <div className="frv-outs">
        {outs.map(([Icon, title, sub], i) => (
          <div key={title} className="frv-out frv-in" style={d(1100 + i * 220)}>
            <Icon size={16} strokeWidth={1.8} />
            <b>{t(title)}</b>
            <span>{t(sub)}</span>
          </div>
        ))}
      </div>
      <div className="frv-ai-row frv-in" style={d(1900)}>
        <Sparkles size={14} strokeWidth={1.9} />
        <span className="frv-ai-text">
          <b>{t("fr.v.aiRow")}</b>
          <span>{t("fr.v.aiRowSub")}</span>
        </span>
        <span className="frv-switch" aria-hidden>
          <i />
        </span>
      </div>
    </div>
  );
}
