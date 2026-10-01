// The visuals of the intro: small, crisp pieces of Annalo's own UI built from the theme tokens
// (so they follow light, dark and every color theme). Motion is CSS only (firstrun.css): each
// element starts after its `--d` delay; reduced motion shows the final state.

import type { CSSProperties, ReactNode } from "react";
import { ArrowRight, Check, CalendarRange, Cpu, DatabaseBackup, FileText, GitBranch, Hash, Link2, Lock, NotebookPen, Server, ShieldCheck, Sparkles, Timer, WandSparkles } from "lucide-react";
import { AnnaloLogo } from "../components/Logo";
import { formatShortcut } from "../lib/shortcut";
import { t } from "../lib/i18n";
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

export function WelcomeVisual() {
  return (
    <div className="frv-welcome">
      <svg className="frv-mark" viewBox="0 0 1000 1000" aria-hidden>
        <path
          pathLength={1}
          fillRule="evenodd"
          d="M458.0,103.4 L491.0,160.1 L96.3,842.8 L256.8,842.8 L305.0,769.1 L235.1,769.1 L268.2,710.6 L687.4,710.6 L760.2,839.9 L902.7,839.9 L574.1,262.0 L535.4,327.2 L628.0,486.8 L502.4,689.8 L377.7,486.8 L574.1,145.9 L1000.0,896.6 L722.4,896.6 L647.8,769.1 L365.4,769.1 L289.9,896.6 L0.0,896.6 Z M502.4,382.0 L562.8,486.8 L502.4,582.2 L441.9,486.8 Z"
        />
      </svg>
      <div className="frv-pills" aria-hidden>
        {([
          [NotebookPen, "fr.pill.notes"],
          [Timer, "fr.pill.time"],
          [Sparkles, "fr.pill.ai"],
          [CalendarRange, "fr.pill.calendar"],
          [Lock, "fr.pill.local"],
        ] as const).map(([Icon, key], i) => (
          <span key={key} className="frv-pill frv-in" style={d(900 + i * 140)}>
            <Icon size={13} strokeWidth={1.9} />
            {t(key as TKey)}
          </span>
        ))}
      </div>
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
          <div className="frv-line frv-in" style={{ ...d(750), width: "64%" }} />
          <div className="frv-task frv-in" style={d(900)}>
            <span className="frv-check on">
              <Check size={10} strokeWidth={3} />
            </span>
            {t("fr.v.notesTask1")}
          </div>
          <div className="frv-task frv-in" style={d(1050)}>
            <span className="frv-check" />
            {t("fr.v.notesTask2")}
          </div>
        </div>
      </Frame>
      <div className="frv-card frv-float frv-pop" style={d(1900)}>
        <div className="frv-card-head">
          <FileText size={13} strokeWidth={1.9} />
          {t("fr.v.notesLink")}
        </div>
        <div className="frv-line" style={{ width: "92%" }} />
        <div className="frv-line" style={{ width: "70%" }} />
        <div className="frv-backlinks">
          <Link2 size={12} strokeWidth={2} />
          {t("fr.v.backlinks")}
        </div>
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
          <span className="frv-zeit-cmd">/zeit</span>
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
          <span className="frv-cats frv-pop" style={d(3000)}>
            SAP CATS
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

export function AiVisual() {
  return (
    <div className="frv-stack">
      <Frame label={t("fr.v.assistant")} className="frv-chat">
        <div className="frv-bubble me frv-in" style={d(150)}>
          {t("fr.v.ask")} <span className="frv-private">#privat</span>
        </div>
        <div className="frv-route frv-in" style={d(900)}>
          <span className="frv-route-chip local">
            <Cpu size={12} strokeWidth={2} />
            {t("fr.v.localModel")}
          </span>
          <span className="frv-route-note">
            <ShieldCheck size={12} strokeWidth={2} />
            {t("fr.v.staysLocal")}
          </span>
        </div>
        <div className="frv-bubble ai frv-in" style={d(1500)}>
          <div className="frv-line" style={{ width: "94%" }} />
          <div className="frv-line" style={{ width: "80%" }} />
          <div className="frv-line" style={{ width: "58%" }} />
        </div>
      </Frame>
      <div className="frv-card frv-lanes frv-in" style={d(2300)}>
        <div className="frv-lane ok">
          <Cpu size={13} strokeWidth={1.9} />
          <span>{t("fr.v.laneLocal")}</span>
          <Check size={13} strokeWidth={2.6} />
        </div>
        <div className="frv-lane">
          <Server size={13} strokeWidth={1.9} />
          <span>{t("fr.v.laneServer")}</span>
          <Lock size={12} strokeWidth={2.2} />
        </div>
      </div>
    </div>
  );
}

export function CalendarVisual() {
  // Day columns with meetings, then the dashed proposals of „Woche vorschlagen“.
  const meetings = [
    { day: 0, top: 10, h: 18, label: t("fr.v.daily") },
    { day: 1, top: 34, h: 28, label: t("fr.v.workshop") },
    { day: 2, top: 10, h: 18, label: t("fr.v.daily") },
    { day: 3, top: 52, h: 22, label: t("fr.v.review") },
    { day: 4, top: 10, h: 18, label: t("fr.v.daily") },
  ];
  const proposals = [
    { day: 0, top: 34, h: 30 },
    { day: 2, top: 32, h: 40 },
    { day: 3, top: 18, h: 26 },
    { day: 4, top: 34, h: 34 },
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
                    <span key={j} className="frv-event frv-in" style={{ ...d(200 + i * 110), top: `${m.top}%`, height: `${m.h}%` }}>
                      {m.label}
                    </span>
                  ))}
                {proposals
                  .filter((p) => p.day === i)
                  .map((p, j) => (
                    <span key={`p${j}`} className="frv-proposal frv-pop" style={{ ...d(1700 + i * 150), top: `${p.top}%`, height: `${p.h}%` }} />
                  ))}
              </div>
            </div>
          ))}
        </div>
      </Frame>
      <div className="frv-card frv-float frv-propose frv-pop" style={d(1300)}>
        <WandSparkles size={14} strokeWidth={1.9} />
        <span>{t("fr.v.propose")}</span>
        <span className="frv-apply frv-pulse" style={d(2700)}>
          {t("fr.v.apply")}
        </span>
      </div>
    </div>
  );
}

export function CaptureVisual({ shortcut }: { shortcut: string }) {
  const keys = (shortcut ? formatShortcut(shortcut, undefined, " ") : "Ctrl Shift Space").split(" ").filter(Boolean);
  return (
    <div className="frv-stack frv-capture-stage">
      <div className="frv-desktop" aria-hidden>
        <div className="frv-app-ghost">
          <div className="frv-line" style={{ width: "40%" }} />
          <div className="frv-line" style={{ width: "88%" }} />
          <div className="frv-line" style={{ width: "76%" }} />
          <div className="frv-line" style={{ width: "82%" }} />
          <div className="frv-line" style={{ width: "54%" }} />
        </div>
      </div>
      <div className="frv-keys" aria-hidden>
        {keys.map((k, i) => (
          <kbd key={`${k}-${i}`} className="frv-key frv-press" style={d(250 + i * 120)}>
            {k}
          </kbd>
        ))}
      </div>
      <div className="frv-capture frv-pop" style={d(900)}>
        <div className="frv-capture-input">
          <span className="frv-type" style={{ ...d(1300), ["--n" as string]: t("fr.v.captureText").length }}>
            {t("fr.v.captureText")}
          </span>
        </div>
        <div className="frv-capture-foot">
          <span className="frv-target-chip">
            <CalendarRange size={12} strokeWidth={2} />
            {t("fr.v.dailyTab")}
          </span>
          <span className="frv-saved frv-pop" style={d(3100)}>
            <Check size={12} strokeWidth={2.6} />
            {t("fr.v.saved")}
          </span>
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
          <AnnaloLogo size={22} />
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
    </div>
  );
}
