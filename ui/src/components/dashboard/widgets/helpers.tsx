// Small helper widgets of the start page: Fokus-Timer (the running focus session as a
// countdown, started and ended through the focus sessions of components/Focus.tsx; no second
// timer), Checkliste (a short list kept in the widget's settings) and Sicherung & Sync (the
// last backup with its destinations and the last Git sync, with „Jetzt sichern“ and „Jetzt
// synchronisieren“). The clock with more time zones is the built-in „Uhr“; quick links are
// the built-in „Links“ (the ribbon's link groups).

import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, CloudUpload, DatabaseBackup, GitBranch, ListChecks, Play, RefreshCw, Square, Target, Timer, X } from "lucide-react";
import { api } from "../../../lib/api";
import { useApp } from "../../../store/app";
import { relative } from "../../../lib/format";
import { t, type TKey } from "../../../lib/i18n";
import { configOf } from "../../../lib/dashboard";
import { countdown, lastChoice, phaseProgress, remainingMs } from "../../../lib/focus";
import { openSettingsSection } from "../../../lib/calnav";
import { addItem, backupHealth, checkItems, clearDone, moveItem, removeItem, syncHealth, toggleItem, type CheckItem, type Health } from "../../../lib/dashnotes";
import type { BackupInfo, GitSyncStatus } from "../../../lib/types";
import type { DestView } from "../../../lib/backupdest";
import { Button, IconButton, Input } from "../../ui";
import { abortFocus, endBreak, nextSession, openFocusDialog, startFocus } from "../../Focus";
import { defineWidget } from "../define";
import { useBoard } from "../board";
import { useLazyData } from "../data";
import { Loadable, Ring, s, useNow } from "../common";
import type { WidgetProps } from "../registry";

// ------------------------------------------------------------------ Fokus-Timer

function PomodoroWidget({ widget }: WidgetProps) {
  const focus = useApp((st) => st.focus);
  const now = useNow(focus ? 1000 : 60_000);
  const size = widget.h >= 7 && widget.w >= 3 ? 104 : 72;
  if (!focus) {
    const last = lastChoice();
    const start = (minutes: number, breakMinutes: number) => void startFocus({ ...last, minutes, breakMinutes, focusMode: false });
    return (
      <div className="dw-pomo idle">
        <Ring value={0} size={size} stroke={5} label={t("dash.h.pomoIdle")}>
          <span className="num dw-pomo-time">{`${String(last.minutes).padStart(2, "0")}:00`}</span>
        </Ring>
        <div className="dw-pomo-actions">
          <Button size="sm" variant="primary" icon={Play} onClick={() => start(25, 5)}>
            {t("dash.h.pomo25")}
          </Button>
          <Button size="sm" onClick={() => start(50, 10)}>
            {t("dash.h.pomo50")}
          </Button>
          <IconButton icon={Target} size="sm" label={t("dash.h.pomoChoose")} onClick={() => openFocusDialog()} />
        </div>
      </div>
    );
  }
  const left = remainingMs(focus, now);
  const brk = focus.phase === "break";
  const goal = focus.session.goal || focus.session.reference;
  return (
    <div className={`dw-pomo ${brk ? "break" : "work"}`}>
      <Ring value={phaseProgress(focus, now)} size={size} stroke={5} tone={brk ? "success" : "accent"} label={t(brk ? "dash.h.pomoBreakLeft" : "dash.h.pomoLeft", { time: countdown(left) })}>
        <span className="num dw-pomo-time">{countdown(left)}</span>
      </Ring>
      <div className="dw-pomo-info">
        <span className="dw-pomo-phase">{brk ? t("dash.focusBreak") : t("dash.h.pomoWork")}</span>
        {goal && !brk && <span className="faint small ellipsis">{goal}</span>}
      </div>
      <div className="dw-pomo-actions">
        {brk ? (
          <>
            <Button size="sm" icon={Play} onClick={() => void nextSession()}>
              {t("dash.h.pomoNext")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void endBreak()}>
              {t("dash.h.pomoEndBreak")}
            </Button>
          </>
        ) : (
          <Button size="sm" icon={Square} onClick={() => void abortFocus()}>
            {t("dash.h.pomoStop")}
          </Button>
        )}
      </div>
    </div>
  );
}

defineWidget({
  kind: "pomodoro",
  label: "dash.w.pomodoro",
  hint: "dash.w.pomodoroHint",
  group: "day",
  size: { w: 3, h: 7 },
  min: { w: 2, h: 4 },
  config: () => ({}),
  icon: Timer,
  look: "ring",
  body: PomodoroWidget,
});

// ------------------------------------------------------------------ Checkliste

function ChecklistWidget({ widget }: WidgetProps) {
  const { setConfig } = useBoard();
  const stored = configOf(widget).items;
  const [items, setItems] = useState<CheckItem[]>(() => checkItems(stored));
  const [text, setText] = useState("");
  const key = JSON.stringify(stored ?? []);
  // Saved (here or in another window): take it over.
  useEffect(() => setItems(checkItems(stored)), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const list = useRef<HTMLUListElement>(null);
  const update = (next: CheckItem[]) => {
    setItems(next);
    setConfig(widget.id, { items: next });
  };
  const done = items.filter((i) => i.done).length;
  return (
    <div className="dw-checklist">
      {items.length === 0 ? (
        <div className="dw-quiet">{t("dash.h.checkEmpty")}</div>
      ) : (
        <ul className="dw-list" ref={list} aria-label={t("dash.w.checklist")}>
          {items.map((it) => (
            <li key={it.id} data-item={it.id} className={`dw-check-item ${it.done ? "done" : ""}`}>
              <button
                type="button"
                role="checkbox"
                aria-checked={it.done}
                className="dw-check"
                aria-label={it.text}
                onClick={() => update(toggleItem(items, it.id))}
                onKeyDown={(e) => {
                  if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
                    e.preventDefault();
                    update(moveItem(items, it.id, e.key === "ArrowUp" ? -1 : 1));
                    requestAnimationFrame(() => list.current?.querySelector<HTMLElement>(`[data-item="${it.id}"] .dw-check`)?.focus());
                  }
                }}
              />
              <span className="grow dw-check-text">
                {it.text}
              </span>
              <span className="dw-check-tools">
                <IconButton icon={ArrowUp} size="sm" label={t("common.up")} onClick={() => update(moveItem(items, it.id, -1))} />
                <IconButton icon={ArrowDown} size="sm" label={t("common.down")} onClick={() => update(moveItem(items, it.id, 1))} />
                <IconButton icon={X} size="sm" label={t("dash.h.checkRemove", { text: it.text })} onClick={() => update(removeItem(items, it.id))} />
              </span>
            </li>
          ))}
        </ul>
      )}
      <form
        className="dw-check-add"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) update(addItem(items, text));
          setText("");
        }}
      >
        <Input value={text} onChange={(e) => setText(e.target.value)} placeholder={t("dash.h.checkAdd")} aria-label={t("dash.h.checkAdd")} maxLength={200} />
      </form>
      {done > 0 && (
        <div className="dw-check-foot faint small">
          <span className="num">{t("dash.h.checkDone", { n: done, total: items.length })}</span>
          <button type="button" className="dw-link" onClick={() => update(clearDone(items))}>
            {t("dash.h.checkClear")}
          </button>
        </div>
      )}
    </div>
  );
}

defineWidget({
  kind: "checklist",
  label: "dash.w.checklist",
  hint: "dash.w.checklistHint",
  group: "tools",
  size: { w: 4, h: 7 },
  min: { w: 2, h: 4 },
  config: () => ({ items: [] }),
  icon: ListChecks,
  look: "list",
  body: ChecklistWidget,
});

// ------------------------------------------------------------------ Sicherung & Sync

interface StatusData {
  backups: BackupInfo[];
  destinations: DestView[];
  git: GitSyncStatus | null;
}

const HEALTH: Record<Health, TKey> = { ok: "dash.h.health.ok", warn: "dash.h.health.warn", error: "dash.h.health.error", off: "dash.h.health.off" };
const DEST: Record<string, TKey> = { ok: "dash.h.dest.ok", waiting: "dash.h.dest.waiting", pending: "dash.h.dest.pending", failing: "dash.h.dest.failing", off: "dash.h.dest.off" };

function Dot({ health }: { health: Health }) {
  return <span className={`dw-health h-${health}`} role="img" aria-label={t(HEALTH[health])} />;
}

/** The last part of a path: `\\server\share\Annalo` → `Annalo`, with the share or drive before it. */
const shortPath = (p: string) => {
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : p;
};

function StatusWidget({ widget }: WidgetProps) {
  const [busy, setBusy] = useState<"backup" | "sync" | null>(null);
  const { data, error, loading, reload } = useLazyData<StatusData>(
    widget.id,
    async () => {
      const [backups, destinations, git] = await Promise.all([api.backups().catch(() => []), api.backupDestinations().catch(() => []), api.gitSyncStatus().catch(() => null)]);
      return { backups, destinations, git };
    },
    { topics: ["sync"], every: 60_000 },
  );
  const backupNow = async () => {
    setBusy("backup");
    try {
      const b = await api.backupNow();
      s().toast({ tone: "success", title: t("dash.h.backedUp"), detail: b.file_name });
    } catch (e) {
      s().error(t("dash.h.backupFailed"), e);
    } finally {
      setBusy(null);
      reload();
    }
  };
  const syncNow = async () => {
    setBusy("sync");
    try {
      const out = await api.gitSyncNow();
      s().toast({ tone: "success", title: t("dash.h.synced"), detail: out.message });
    } catch (e) {
      s().error(t("dash.h.syncFailed"), e);
    } finally {
      setBusy(null);
      reload();
    }
  };
  return (
    <Loadable loading={loading} error={error}>
      {() => {
        const d = data!;
        const last = d.backups.reduce<string | null>((m, b) => (!m || b.created_at > m ? b.created_at : m), null);
        const bh = backupHealth(last, d.destinations);
        const gh = syncHealth(d.git);
        const dests = d.destinations.filter((x) => x.enabled);
        return (
          <div className="dw-status">
            <section className="dw-status-block" aria-label={t("dash.h.backup")}>
              <div className="dw-status-head">
                <DatabaseBackup size={14} aria-hidden className="faint" />
                <span className="dw-status-name">{t("dash.h.backup")}</span>
                <Dot health={bh} />
                <Button size="sm" variant="ghost" icon={CloudUpload} loading={busy === "backup"} disabled={busy != null} onClick={backupNow}>
                  {t("dash.h.backupNow")}
                </Button>
              </div>
              <div className="dw-status-line">{last ? t("dash.h.lastBackup", { when: relative(last) }) : t("dash.h.noBackup")}</div>
              {dests.length > 0 && (
                <ul className="dw-status-dests">
                  {dests.slice(0, 3).map((x) => (
                    <li key={x.id} title={x.path}>
                      <span className={`dw-health h-${x.health === "failing" ? "error" : x.health === "ok" ? "ok" : "warn"}`} aria-hidden />
                      <span className="ellipsis grow mono small">{shortPath(x.path)}</span>
                      <span className="faint small">{t(DEST[x.health] ?? "dash.h.dest.waiting")}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className="dw-status-block" aria-label={t("dash.h.sync")}>
              <div className="dw-status-head">
                <GitBranch size={14} aria-hidden className="faint" />
                <span className="dw-status-name">{t("dash.h.sync")}</span>
                <Dot health={gh} />
                {gh === "off" ? (
                  <Button size="sm" variant="ghost" onClick={() => openSettingsSection("backup")}>
                    {t("dash.h.setup")}
                  </Button>
                ) : (
                  <Button size="sm" variant="ghost" icon={RefreshCw} loading={busy === "sync"} disabled={busy != null} onClick={syncNow}>
                    {t("dash.h.syncNow")}
                  </Button>
                )}
              </div>
              {gh === "off" ? (
                <div className="dw-status-line faint">{t("dash.n.syncOff")}</div>
              ) : (
                <>
                  <div className="dw-status-line">{d.git?.last_at ? t("dash.h.lastSync", { when: relative(d.git.last_at) }) : t("dash.h.neverSynced")}</div>
                  {d.git?.last_error && <div className="dw-status-error">{d.git.last_error}</div>}
                  {!!d.git?.pending_changes && <div className="faint small">{t("dash.h.pending", { n: d.git.pending_changes })}</div>}
                </>
              )}
            </section>
          </div>
        );
      }}
    </Loadable>
  );
}

defineWidget({
  kind: "status",
  label: "dash.w.status",
  hint: "dash.w.statusHint",
  group: "tools",
  size: { w: 4, h: 7 },
  min: { w: 3, h: 5 },
  config: () => ({}),
  icon: DatabaseBackup,
  look: "list",
  body: StatusWidget,
  opener: () => () => openSettingsSection("backup"),
});
