// The menu of a `/zeit` chip and its entry dialog („Eintrag bearbeiten“), for every editor.

import { Suspense, lazy, useEffect, useState } from "react";
import { Pencil, RotateCcw, Timer, Trash2 } from "lucide-react";
import { useMenu, type MenuEntry } from "../components/ui";
import { api } from "../lib/api";
import { t } from "../lib/i18n";
import type { TimeEntryRow } from "../lib/types";
import { useApp } from "../store/app";
import { useWbs } from "../views/wbs";
import { CHIP_MENU_EVENT, EDIT_ENTRY_EVENT, type ChipMenuRequest } from "./timeChip";

const EntryDialog = lazy(() => import("../views/TimesheetView").then((m) => ({ default: m.EntryDialog })));

/** What the chip's menu offers: edit a booked chip, book one without booking, remove it. */
export function chipMenuItems(r: Pick<ChipMenuRequest, "status" | "edit" | "book" | "remove">): MenuEntry[] {
  if (r.status === "linked" || r.status === "unknown")
    return [{ label: t("chip.edit"), icon: Pencil, onSelect: r.edit }, "separator", { label: t("chip.removeWithBooking"), icon: Trash2, danger: true, onSelect: r.remove }];
  return [
    { label: r.status === "copy" ? t("chip.book") : t("chip.bookAgain"), icon: r.status === "copy" ? Timer : RotateCcw, onSelect: r.book },
    "separator",
    { label: t("chip.remove"), icon: Trash2, onSelect: r.remove },
  ];
}

function EditEntry({ row, onClose }: { row: TimeEntryRow; onClose: () => void }) {
  const { wbs, las } = useWbs();
  return (
    <Suspense fallback={null}>
      <EntryDialog entry={row} wbs={wbs} las={las} defaultDay={new Date(row.start_time)} onClose={onClose} />
    </Suspense>
  );
}

export function ChipHost() {
  const [menu, , openMenuAt] = useMenu();
  const [editing, setEditing] = useState<TimeEntryRow | null>(null);
  useEffect(() => {
    const onMenu = (e: Event) => {
      const r = (e as CustomEvent<ChipMenuRequest>).detail;
      openMenuAt(r.anchor, chipMenuItems(r), { keyboard: r.keyboard });
    };
    const onEdit = async (e: Event) => {
      const { id, pageId } = (e as CustomEvent<{ id: number; pageId: number }>).detail;
      const s = useApp.getState();
      try {
        const [state] = await api.chipStates(pageId, [{ id, target: "" }]);
        const row = state?.row;
        if (!row) return s.toast({ tone: "warning", title: t("chip.stateMissing") });
        if (row.status_flag === "exported") return s.toast({ tone: "info", title: t("time.alreadyExported") });
        setEditing(row);
      } catch (err) {
        s.error(t("chip.editFailed"), err);
      }
    };
    window.addEventListener(CHIP_MENU_EVENT, onMenu);
    window.addEventListener(EDIT_ENTRY_EVENT, onEdit);
    return () => {
      window.removeEventListener(CHIP_MENU_EVENT, onMenu);
      window.removeEventListener(EDIT_ENTRY_EVENT, onEdit);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <>
      {menu}
      {editing && <EditEntry row={editing} onClose={() => setEditing(null)} />}
    </>
  );
}
