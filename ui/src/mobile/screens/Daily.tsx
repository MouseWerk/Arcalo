// Tagesnotiz: the daily note of a day, read or edited; a day without one shows an empty state
// (the note is created only when you start it, so it does not meet the desktop's note of that
// day as a conflict).

import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, NotebookPen, Pencil } from "lucide-react";
import { api } from "../../lib/api";
import { addDays, dateLocale, isoDay } from "../../lib/format";
import { t } from "../../lib/i18n";
import type { PageDoc } from "../../lib/types";
import { mobileApi } from "../api";
import { errorText, useMobile } from "../context";
import { noonOf } from "../model";
import { Empty, Header, Spinner } from "../ui";
import { PageBody } from "./Notes";

export function DailyScreen({ date: start }: { date: string }) {
  const m = useMobile();
  const [date, setDate] = useState(start);
  const [doc, setDoc] = useState<PageDoc | null | undefined>(undefined);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    let live = true;
    setDoc(undefined);
    mobileApi
      .daily(date, false)
      .then((page) => (page ? api.page(page.id) : null))
      .then((d) => live && setDoc(d))
      .catch((e) => {
        m.toast("error", errorText(e));
        if (live) setDoc(null);
      });
    return () => {
      live = false;
    };
  }, [date, m.version]); // eslint-disable-line react-hooks/exhaustive-deps

  const create = async () => {
    try {
      const page = await mobileApi.daily(date, true);
      if (page) {
        setDoc(await api.page(page.id));
        setEditing(true);
      }
    } catch (e) {
      m.toast("error", errorText(e));
    }
  };
  const shift = (n: number) => {
    setEditing(false);
    setDate(isoDay(addDays(noonOf(date), n)));
  };
  const today = isoDay(new Date());
  return (
    <div className="m-screen">
      <Header
        title={t("mob.daily.title")}
        eyebrow={noonOf(date).toLocaleDateString(dateLocale(), { weekday: "short", day: "numeric", month: "long" })}
        back="back"
        actions={
          <>
            <button type="button" className="m-icon-btn" aria-label={t("mob.daily.prev")} onClick={() => shift(-1)}>
              <ChevronLeft size={22} />
            </button>
            <button type="button" className="m-icon-btn" aria-label={t("mob.daily.next")} onClick={() => shift(1)} disabled={date >= today}>
              <ChevronRight size={22} />
            </button>
            {doc && (
              <button type="button" className="m-icon-btn" aria-label={editing ? t("mob.notes.done") : t("mob.notes.edit")} onClick={() => setEditing((v) => !v)}>
                {editing ? <span className="m-head-text">{t("mob.notes.done")}</span> : <Pencil size={20} />}
              </button>
            )}
          </>
        }
      />
      {doc === undefined ? (
        <div className="m-loading">
          <Spinner />
        </div>
      ) : doc === null ? (
        <div className="m-scroll">
          <Empty
            icon={<NotebookPen size={28} />}
            text={t("mob.daily.empty")}
            action={
              <button type="button" className="m-btn m-btn-primary" onClick={() => void create()}>
                {t("mob.daily.create")}
              </button>
            }
          />
        </div>
      ) : (
        <PageBody doc={doc} editing={editing} onSaved={(content) => setDoc({ ...doc, content })} onDone={() => setEditing(false)} />
      )}
    </div>
  );
}
