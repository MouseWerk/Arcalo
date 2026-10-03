import { useEffect, useState } from "react";
import { Hash } from "lucide-react";
import { api } from "../lib/api";
import { useApp } from "../store/app";
import { EmptyState, Skeleton } from "../components/ui";
import { PageIcon } from "../components/icons";
import { relative } from "../lib/format";
import type { Page } from "../lib/types";
import { t } from "../lib/i18n";

export function TagView({ tag }: { tag: string }) {
  const pages = useApp((s) => s.pages);
  const [list, setList] = useState<Page[] | null>(null);
  useEffect(() => {
    api.tagPages(tag).then(setList).catch(() => setList([]));
  }, [tag, pages]);
  const s = useApp.getState;
  return (
    <div className="view-scroll">
      <div className="view narrow">
        <header className="view-header">
          <div>
            <h1 className="tag-heading">
              <Hash size={22} strokeWidth={2} />
              {tag}
            </h1>
            <div className="view-sub">{list ? `${list.length} ${list.length === 1 ? "Seite" : "Seiten"}` : ""}</div>
          </div>
        </header>
        {!list ? (
          <Skeleton />
        ) : list.length === 0 ? (
          <EmptyState icon={Hash} title={t("tag.none")}>{t("tag.noneHint")}</EmptyState>
        ) : (
          <div className="page-list">
            {list.map((p) => (
              <button key={p.id} type="button" className="page-list-item" onClick={(e) => s().openPage(p.id, { newTab: e.ctrlKey || e.metaKey })}>
                <PageIcon name={p.icon} size={16} />
                <span className="grow">{p.title}</span>
                <span className="faint small">{relative(p.updated_at)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
