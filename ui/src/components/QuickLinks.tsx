// Links at the top of the sidebar: web pages, tools, mail and local folders, each with an icon.
// Saved on their own (`quick_links_save`), like the start page's widgets.

import { useState } from "react";
import { ArrowDown, ArrowUp, ChevronRight, Pencil, Plus, Trash2 } from "lucide-react";
import { useApp } from "../store/app";
import { api } from "../lib/api";
import type { QuickLink } from "../lib/types";
import { Button, Dialog, Field, IconButton, Input, useMenu, type MenuEntry } from "./ui";
import { PAGE_ICONS, PageIcon } from "./icons";
import { useT } from "../lib/i18n";

const OPEN_KEY = "annalo.quicklinks-open";
/** One shared empty list: a new [] per render would look like a change and re-render forever. */
const NONE: QuickLink[] = [];

/** Whether the address is a local folder or file (the shell decides for real when opening). */
const isPath = (u: string) => /^(file:|[A-Za-z]:[\\/]|\\\\|\/|~\/)/i.test(u.trim());

/** An icon that fits the address when none was picked. */
export function guessIcon(url: string): string {
  const u = url.toLowerCase();
  if (u.startsWith("mailto:")) return "mail";
  if (/jira|ticket|servicenow|redmine/.test(u)) return "ticket";
  if (/git(hub|lab)|bitbucket|azure\.com\/.*_git/.test(u)) return "code";
  if (/confluence|wiki|notion|docs\./.test(u)) return "book-open";
  if (/teams|zoom|meet\./.test(u)) return "video";
  if (/grafana|kibana|powerbi|dashboard/.test(u)) return "chart";
  if (/sap|s4|fiori/.test(u)) return "database";
  if (isPath(url)) return "folder";
  return "globe";
}

export function QuickLinks() {
  const t = useT();
  const links = useApp((s) => s.settings?.settings.quick_links ?? NONE);
  const [open, setOpen] = useState(() => localStorage.getItem(OPEN_KEY) !== "0");
  const [editing, setEditing] = useState<{ index: number | null; link: QuickLink } | null>(null);
  const [menu, openMenu] = useMenu();
  const s = useApp.getState;

  const save = async (next: QuickLink[]) => {
    try {
      s().set({ settings: await api.saveQuickLinks(next) });
    } catch (e) {
      s().error(t("links.saveFailed"), e);
    }
  };
  const go = (i: number) => api.openQuickLink(i).catch((e) => s().error(t("links.openFailed"), e));
  const toggle = () => {
    setOpen(!open);
    localStorage.setItem(OPEN_KEY, open ? "0" : "1");
  };
  const move = (i: number, d: number) => {
    const next = [...links];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    save(next);
  };
  const entries = (l: QuickLink, i: number): MenuEntry[] => [
    { label: t("links.edit"), icon: Pencil, onSelect: () => setEditing({ index: i, link: l }) },
    { label: t("links.up"), icon: ArrowUp, disabled: i === 0, onSelect: () => move(i, -1) },
    { label: t("links.down"), icon: ArrowDown, disabled: i === links.length - 1, onSelect: () => move(i, 1) },
    "separator",
    { label: t("links.remove"), icon: Trash2, danger: true, onSelect: () => save(links.filter((_, j) => j !== i)) },
  ];

  return (
    <section className="quick-links" aria-label={t("links.title")}>
      <div className="quick-links-head">
        <button type="button" className="quick-links-toggle" aria-expanded={open} onClick={toggle}>
          <ChevronRight size={13} className={open ? "open" : ""} />
          {t("links.title")}
        </button>
        <IconButton icon={Plus} label={t("links.add")} size={22} iconSize={14} onClick={() => setEditing({ index: null, link: { name: "", url: "", icon: "" } })} />
      </div>
      {open && links.length > 0 && (
        <ul className="quick-links-list">
          {links.map((l, i) => (
            <li key={`${i}-${l.url}`}>
              <button type="button" className="quick-link" title={l.url} onClick={() => go(i)} onContextMenu={(e) => openMenu(e, entries(l, i))}>
                <PageIcon name={l.icon || guessIcon(l.url)} size={15} className="tree-icon" />
                <span className="tree-label">{l.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {open && links.length === 0 && <p className="quick-links-empty">{t("links.empty")}</p>}
      {menu}
      {editing && (
        <LinkDialog
          initial={editing.link}
          isNew={editing.index === null}
          onClose={() => setEditing(null)}
          onSave={(l) => {
            const next = [...links];
            if (editing.index === null) next.push(l);
            else next[editing.index] = l;
            save(next);
            setEditing(null);
          }}
        />
      )}
    </section>
  );
}

function LinkDialog({ initial, isNew, onClose, onSave }: { initial: QuickLink; isNew: boolean; onClose: () => void; onSave: (l: QuickLink) => void }) {
  const t = useT();
  const [link, setLink] = useState(initial);
  const [iconTouched, setIconTouched] = useState(!!initial.icon);
  const icon = link.icon || guessIcon(link.url);
  const valid = link.url.trim().length > 0;
  const submit = () => valid && onSave({ ...link, icon: iconTouched ? link.icon : guessIcon(link.url) });
  return (
    <Dialog
      open
      onClose={onClose}
      title={isNew ? t("links.add") : t("links.edit")}
      description={t("links.help")}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" disabled={!valid} onClick={submit}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      <form
        className="link-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label={t("links.url")}>
          <Input value={link.url} onChange={(e) => setLink({ ...link, url: e.target.value })} placeholder="https://jira.firma.de · C:\Projekte · mailto:team@firma.de" data-autofocus />
        </Field>
        <Field label={t("links.name")}>
          <Input value={link.name} onChange={(e) => setLink({ ...link, name: e.target.value })} placeholder={t("links.namePlaceholder")} />
        </Field>
        <div className="field">
          <span className="field-label">{t("links.icon")}</span>
          <div className="icon-picker inline" role="listbox" aria-label={t("links.icon")}>
            {Object.entries(PAGE_ICONS).map(([name, Icon]) => (
              <button
                key={name}
                type="button"
                role="option"
                aria-selected={icon === name}
                aria-label={name}
                className={icon === name ? "on" : ""}
                onClick={() => {
                  setIconTouched(true);
                  setLink({ ...link, icon: name });
                }}
              >
                <Icon size={16} strokeWidth={1.75} />
              </button>
            ))}
          </div>
        </div>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
