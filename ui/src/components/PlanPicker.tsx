// „Im Kalender planen…“: a task or issue becomes a focus block today or tomorrow in a free slot
// (meetings and other blocks avoided). The keyboard way to plan, next to dragging into the Kalender.

import { useEffect, useState } from "react";
import { CalendarClock } from "lucide-react";
import { api } from "../lib/api";
import { useApp } from "../store/app";
import { Dialog, Field, Segmented, Select, Spinner } from "./ui";
import { useT } from "../lib/i18n";
import { addDays, dateLong, isoDay, time } from "../lib/format";
import { blockKey, blockMinutes, itemTitle, linkOf, onPlanPicker, type PlanItem } from "../lib/blocks";
import { openCalendarView } from "../lib/calnav";

const LENGTHS = [30, 45, 60, 90, 120];

export function PlanPickerHost() {
  const [item, setItem] = useState<PlanItem | null>(null);
  useEffect(() => onPlanPicker(setItem), []);
  return item ? <PlanPicker item={item} onClose={() => setItem(null)} /> : null;
}

function PlanPicker({ item, onClose }: { item: PlanItem; onClose: () => void }) {
  const t = useT();
  const cal = useApp((s) => s.settings?.settings.calendar);
  const [day, setDay] = useState<"today" | "tomorrow">("today");
  const [minutes, setMinutes] = useState(() => blockMinutes(cal));
  const [slots, setSlots] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const date = day === "today" ? new Date() : addDays(new Date(), 1);
  const iso = isoDay(date);

  useEffect(() => {
    let live = true;
    setSlots(null);
    api
      .blockFreeSlots(iso, minutes)
      .then((s) => live && setSlots(s))
      .catch((e) => {
        if (!live) return;
        setSlots([]);
        useApp.getState().error(t("blocks.slotsFailed"), e);
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [iso, minutes]);

  const plan = async (start: string) => {
    if (busy) return;
    setBusy(true);
    const end = new Date(new Date(start).getTime() + minutes * 60_000).toISOString();
    try {
      const b = await api.blockCreate({ start, end, link: linkOf(item), title: "" });
      onClose();
      useApp.getState().toast({
        tone: "success",
        title: t("blocks.planned", { when: `${dateLong(`${iso}T12:00:00`)}, ${time(b.start)}–${time(b.end)}` }),
        detail: b.title,
        action: { label: t("blocks.showInCalendar"), run: () => openCalendarView({ date: iso, key: blockKey(b.id) }) },
      });
    } catch (e) {
      useApp.getState().error(t("blocks.createFailed"), e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} title={t("blocks.planTitle")} description={itemTitle(item)} width={440}>
      <div className="plan-picker">
        <div className="plan-picker-row">
          <Field label={t("blocks.day")}>
            <Segmented
              label={t("blocks.day")}
              value={day}
              onChange={setDay}
              options={[
                { value: "today", label: t("blocks.today") },
                { value: "tomorrow", label: t("blocks.tomorrow") },
              ]}
            />
          </Field>
          <Field label={t("blocks.length")}>
            <Select
              aria-label={t("blocks.length")}
              value={String(minutes)}
              onChange={(e) => setMinutes(Number(e.target.value))}
              options={[...new Set([...LENGTHS, blockMinutes(cal)])].sort((a, b) => a - b).map((m) => ({ value: String(m), label: t("focus.minutes", { n: m }) }))}
            />
          </Field>
        </div>
        <div className="plan-picker-head">
          <span>{t("blocks.slots")}</span>
          <span className="faint">{dateLong(`${iso}T12:00:00`)}</span>
        </div>
        {slots == null ? (
          <div className="plan-picker-wait">
            <Spinner />
          </div>
        ) : slots.length === 0 ? (
          <p className="plan-picker-none faint">{t("blocks.noSlots")}</p>
        ) : (
          <div className="plan-slots" role="group" aria-label={t("blocks.slots")}>
            {slots.map((s) => (
              <button key={s} type="button" className="plan-slot" disabled={busy} onClick={() => void plan(s)}>
                <CalendarClock size={13} aria-hidden />
                <span className="num">
                  {time(s)}–{time(new Date(new Date(s).getTime() + minutes * 60_000).toISOString())}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </Dialog>
  );
}
