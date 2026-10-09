// Focus blocks in the Kalender: loading them, a block in the time grid (moved and resized with
// the mouse or the keyboard) and its side panel (link, focus session, task done, Outlook, delete).

import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { CalendarClock, Check, CircleCheck, ExternalLink, FileText, Play, RefreshCw, Target, Timer, Trash2, X } from "lucide-react";
import { api, on } from "../lib/api";
import { useApp } from "../store/app";
import { Badge, Button, IconButton, Input } from "../components/ui";
import { useT, t as tr } from "../lib/i18n";
import { dateLong, fmtDuration } from "../lib/format";
import { blockTime, linkLabel, moved, resized, SNAP } from "../lib/blocks";
import { openFocusDialog } from "../components/Focus";
import { openIssue } from "../lib/jiraActions";
import type { BlockPatch, FocusBlock } from "../lib/types";
import { isComposing } from "../lib/ime";

/** The blocks of `from..to`, reloaded when they change anywhere; `patch` updates one at once (before the save). */
export function useBlocks(from: Date, to: Date, version: number) {
  const [blocks, setBlocks] = useState<FocusBlock[]>([]);
  const [tick, setTick] = useState(0);
  const seq = useRef(0);
  const key = `${from.toISOString()}|${to.toISOString()}`;
  useEffect(() => {
    const n = ++seq.current;
    api
      .blocks(from.toISOString(), to.toISOString())
      .then((b) => n === seq.current && setBlocks(b))
      .catch((e) => n === seq.current && useApp.getState().error(tr("blocks.loadFailed"), e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, version, tick]);
  useEffect(() => {
    const off = on("blocks://changed", () => setTick((x) => x + 1));
    return () => void off.then((f) => f());
  }, []);
  const patch = useCallback((id: number, p: Partial<FocusBlock> | null) => {
    setBlocks((list) => (p ? list.map((b) => (b.id === id ? { ...b, ...p } : b)) : list.filter((b) => b.id !== id)));
  }, []);
  return { blocks, patch, reload: () => setTick((x) => x + 1) };
}

/** Saves a move or resize (shown at once, reverted when it fails). */
export async function saveBlock(b: FocusBlock, p: BlockPatch, local: (id: number, p: Partial<FocusBlock> | null) => void) {
  local(b.id, p as Partial<FocusBlock>);
  try {
    local(b.id, await api.blockUpdate(b.id, p));
  } catch (e) {
    local(b.id, { start: b.start, end: b.end, title: b.title });
    useApp.getState().error(tr("blocks.saveFailed"), e);
  }
}

/** Deletes a block; the message can bring it back (as a new block). */
export async function deleteBlock(b: FocusBlock, local: (id: number, p: Partial<FocusBlock> | null) => void) {
  local(b.id, null);
  try {
    await api.blockDelete(b.id);
    useApp.getState().toast({
      tone: "info",
      title: tr("blocks.deleted"),
      detail: b.title,
      action: {
        label: tr("common.undo"),
        run: () => void api.blockCreate({ title: b.title, start: b.start, end: b.end, link: b.link, reference: b.reference }).catch((e) => useApp.getState().error(tr("blocks.createFailed"), e)),
      },
    });
  } catch (e) {
    useApp.getState().error(tr("blocks.saveFailed"), e);
  }
}

interface Drag {
  mode: "move" | "resize";
  x: number;
  y: number;
  colWidth: number;
  minutes: number;
  days: number;
  active: boolean;
}

/** A block in the time grid: a click opens it, dragging moves it (also to another day), the handle at its foot resizes it; the keyboard does the same. */
export function BlockItem(props: {
  block: FocusBlock;
  style: CSSProperties;
  hourPx: number;
  dayIndex: number;
  dayCount: number;
  selected: boolean;
  past: boolean;
  compact: boolean;
  onSelect: (id: number) => void;
  onChange: (b: FocusBlock, p: BlockPatch) => void;
  onDelete: (b: FocusBlock) => void;
}) {
  const t = useT();
  const { block: b, hourPx } = props;
  const [drag, setDrag] = useState<Drag | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const resize = (e.target as HTMLElement).closest(".calv-block-handle") != null;
    const col = ref.current?.closest(".calv-col");
    e.preventDefault();
    e.stopPropagation();
    ref.current?.focus({ preventScroll: true });
    ref.current?.setPointerCapture?.(e.pointerId);
    setDrag({ mode: resize ? "resize" : "move", x: e.clientX, y: e.clientY, colWidth: col?.getBoundingClientRect().width ?? 1, minutes: 0, days: 0, active: false });
  };
  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    const dy = e.clientY - drag.y;
    const dx = e.clientX - drag.x;
    const active = drag.active || Math.abs(dy) > 3 || Math.abs(dx) > 3;
    const minutes = Math.round(((dy / hourPx) * 60) / SNAP) * SNAP;
    const days = drag.mode === "move" ? Math.max(-props.dayIndex, Math.min(props.dayCount - 1 - props.dayIndex, Math.round(dx / drag.colWidth))) : 0;
    if (active !== drag.active || minutes !== drag.minutes || days !== drag.days) setDrag({ ...drag, active, minutes, days });
  };
  const up = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    ref.current?.releasePointerCapture?.(e.pointerId);
    setDrag(null);
    if (!drag.active) {
      props.onSelect(b.id);
      return;
    }
    if (!drag.minutes && !drag.days) return;
    props.onChange(b, drag.mode === "move" ? moved(b, drag.minutes, drag.days) : resized(b, drag.minutes));
  };

  const key = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (isComposing(e)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    let p: BlockPatch | null = null;
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      const d = e.key === "ArrowUp" ? -SNAP : SNAP;
      p = e.shiftKey ? resized(b, d) : moved(b, d);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      const d = e.key === "ArrowLeft" ? -1 : 1;
      if (props.dayIndex + d < 0 || props.dayIndex + d >= props.dayCount) return;
      p = moved(b, 0, d);
    } else if (e.key === "Enter" || e.key === " " || e.key === "F2") {
      e.preventDefault();
      props.onSelect(b.id);
      return;
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      props.onDelete(b);
      return;
    }
    if (!p) return;
    e.preventDefault();
    props.onChange(b, p);
  };

  // While dragging: shown where it lands.
  const shift = drag?.active ? drag : null;
  const top = Number(props.style.top ?? 0) + (shift?.mode === "move" ? (shift.minutes / 60) * hourPx : 0);
  const height = Math.max(hourPx / 4 - 2, Number(props.style.height ?? 0) + (shift?.mode === "resize" ? (shift.minutes / 60) * hourPx : 0));
  const shown = shift ? (shift.mode === "move" ? moved(b, shift.minutes, shift.days) : resized(b, shift.minutes)) : b;
  const link = linkLabel(b);
  const label = t("blocks.label", { title: b.title, time: blockTime(b) });
  return (
    <div
      ref={ref}
      role="button"
      tabIndex={0}
      data-block={b.id}
      className={`calv-block ${props.selected ? "selected" : ""} ${props.past ? "past" : ""} ${drag?.active ? "dragging" : ""} ${props.compact ? "short" : ""} ${b.task_done ? "done" : ""}`}
      style={{ ...props.style, top, height, transform: shift?.days ? `translateX(${shift.days * shift.colWidth}px)` : undefined }}
      aria-label={label}
      aria-description={t("blocks.keys")}
      aria-pressed={props.selected}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={() => setDrag(null)}
      onKeyDown={key}
    >
      <span className="calv-block-title">
        {b.link.kind === "task" && (b.task_done ? <CircleCheck size={11} aria-hidden /> : <Target size={11} aria-hidden />)}
        <span className="ellipsis">{b.title}</span>
      </span>
      <span className="calv-block-meta">
        <span className="num">{blockTime(shown)}</span>
        {link && link !== b.title && !props.compact && <span className="ellipsis calv-block-link">{link}</span>}
      </span>
      <span className="calv-block-handle" aria-hidden title={t("blocks.resize")} />
    </div>
  );
}

/** The side panel of a block. */
export function BlockDetail({ block: b, timeOn, onClose, onChange, onDelete }: { block: FocusBlock; timeOn: boolean; onClose: () => void; onChange: (b: FocusBlock, p: BlockPatch) => void; onDelete: (b: FocusBlock) => void }) {
  const t = useT();
  const s = useApp.getState;
  const [title, setTitle] = useState(b.title);
  const [busy, setBusy] = useState(false);
  useEffect(() => setTitle(b.title), [b.id, b.title]);
  const rename = () => {
    const v = title.trim();
    if (v && v !== b.title) onChange(b, { title: v });
    else setTitle(b.title);
  };
  const minutes = Math.round((new Date(b.end).getTime() - new Date(b.start).getTime()) / 60_000);
  const reference = b.reference || b.suggested_reference || "";

  const focus = () =>
    openFocusDialog({ reference: reference || undefined, goal: b.title, minutes: Math.min(240, minutes), blockId: b.id });
  const taskDone = async () => {
    setBusy(true);
    try {
      await api.blockTaskDone(b.id);
    } catch (e) {
      s().error(t("blocks.taskFailed"), e);
    } finally {
      setBusy(false);
    }
  };
  const retry = async () => {
    setBusy(true);
    try {
      await api.blocksOutlookRetry();
    } catch {
      /* the state line shows why */
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="calv-detail calv-block-detail" id="calv-detail" aria-label={t("blocks.title")}>
      <div className="calv-detail-head">
        <span className="calv-detail-source">
          <span className="calv-block-swatch" aria-hidden />
          <span className="ellipsis">{t("blocks.title")}</span>
        </span>
        <IconButton icon={X} label={t("common.close")} onClick={onClose} />
      </div>
      <div className="calv-detail-top">
        <Input
          className="calv-block-name"
          value={title}
          aria-label={t("blocks.name")}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={rename}
          onKeyDown={(e) => {
            if (isComposing(e)) return;
            if (e.key === "Enter") (e.preventDefault(), rename(), (e.target as HTMLInputElement).blur());
            if (e.key === "Escape") (e.stopPropagation(), setTitle(b.title));
          }}
        />
        <div className="calv-detail-when">
          <span>{dateLong(b.start)}</span>
          <span>
            {blockTime(b)} · {fmtDuration(minutes)}
          </span>
        </div>
      </div>

      {b.link.kind !== "none" && (
        <section className="calv-block-section">
          <h3>{t(b.link.kind === "task" ? "blocks.task" : b.link.kind === "issue" ? "blocks.issue" : "blocks.page")}</h3>
          {b.link.kind === "task" && (
            <div className="calv-block-link-row">
              <span className={`calv-block-task ${b.task_done ? "done" : ""}`}>
                {b.task_done ? <Check size={13} aria-hidden /> : <Target size={13} aria-hidden />}
                <span>{b.link.text}</span>
              </span>
              {b.task_done == null && <span className="faint small">{t("blocks.taskGone")}</span>}
              {b.page_title && (
                <Button size="sm" variant="ghost" icon={FileText} onClick={(e) => b.link.kind === "task" && s().openPage(b.link.page_id, { newTab: e.ctrlKey || e.metaKey })}>
                  {b.page_title}
                </Button>
              )}
            </div>
          )}
          {b.link.kind === "issue" && (
            <div className="calv-block-link-row">
              <span className="calv-block-issue">
                <b className="mono">{b.link.key}</b> {b.issue_summary && <span>{b.issue_summary}</span>}
              </span>
              {b.issue_status && <Badge>{b.issue_status}</Badge>}
              <Button size="sm" variant="ghost" icon={ExternalLink} onClick={(e) => b.link.kind === "issue" && void openIssue(b.link.key, { browser: e.ctrlKey || e.metaKey })}>
                {t("blocks.openIssue")}
              </Button>
            </div>
          )}
          {b.link.kind === "page" && (
            <div className="calv-block-link-row">
              <Button size="sm" variant="ghost" icon={FileText} onClick={(e) => b.link.kind === "page" && s().openPage(b.link.page_id, { newTab: e.ctrlKey || e.metaKey })}>
                {b.page_title ?? t("blocks.openPage")}
              </Button>
            </div>
          )}
        </section>
      )}

      {timeOn && (
        <section className="calv-block-section">
          <h3>{t("focus.ref")}</h3>
          <div className="calv-block-ref">
            {b.reference ? (
              <b className="mono">{b.reference}</b>
            ) : b.suggested_reference ? (
              <>
                <b className="mono">{b.suggested_reference}</b> <span className="faint">({t("blocks.fromLink")})</span>
              </>
            ) : (
              <span className="faint">{t("blocks.noRef")}</span>
            )}
          </div>
        </section>
      )}

      <div className="calv-block-states">
        {b.focus_minutes > 0 && (
          <span className="calv-block-state">
            <Target size={13} aria-hidden /> {t("blocks.focused", { time: fmtDuration(b.focus_minutes) })}
          </span>
        )}
        {timeOn && b.entry_id != null && (
          <span className="calv-block-state ok">
            <Timer size={13} aria-hidden /> {t("blocks.booked")}
          </span>
        )}
        {b.outlook === "written" && (
          <span className="calv-block-state ok" data-outlook="written">
            <CalendarClock size={13} aria-hidden /> {t("blocks.outlookWritten")}
          </span>
        )}
        {b.outlook === "pending" && (
          <span className="calv-block-state warn" data-outlook="pending">
            <CalendarClock size={13} aria-hidden />
            <span>
              {t("blocks.outlookPending")}
              {b.outlook_error ? <span className="faint small calv-block-error">{b.outlook_error}</span> : null}
            </span>
            <Button size="sm" variant="ghost" icon={RefreshCw} loading={busy} onClick={() => void retry()}>
              {t("blocks.retry")}
            </Button>
          </span>
        )}
      </div>

      <div className="calv-detail-actions calv-block-actions">
        <Button variant="primary" icon={Play} onClick={focus}>
          {t("blocks.startFocus")}
        </Button>
        {b.link.kind === "task" && b.task_done === false && (
          <Button icon={Check} loading={busy} onClick={() => void taskDone()}>
            {t("blocks.taskDone")}
          </Button>
        )}
        <Button variant="ghost" icon={Trash2} className="calv-block-delete" onClick={() => onDelete(b)}>
          {t("common.delete")}
        </Button>
      </div>
    </aside>
  );
}

/** Where a drop would land (dashed outline, the default length). */
export function DropGhost({ minute, length, hourPx }: { minute: number; length: number; hourPx: number }) {
  const t = useT();
  return (
    <div className="calv-block-ghost" style={{ top: (minute / 60) * hourPx, height: Math.max(12, (length / 60) * hourPx - 2) }} aria-hidden>
      <span>
        {t("blocks.dropHere")} · {String(Math.floor(minute / 60)).padStart(2, "0")}:{String(minute % 60).padStart(2, "0")}
      </span>
    </div>
  );
}
