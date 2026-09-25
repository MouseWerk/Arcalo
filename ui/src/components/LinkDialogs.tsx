// Dialogs of the ribbon links: one for a link or app (address, name, icon, „In Gruppe“), and
// one for a group (name, icon, color and its entries, which can be added, edited, reordered by
// dragging or Alt+arrow keys, and moved to the ribbon or another group).

import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { AppWindow, ArrowRightLeft, FolderClosed, GripVertical, Link2, Pencil, Plus, X, type LucideIcon } from "lucide-react";
import type { QuickLink } from "../lib/types";
import { Button, Dialog, Field, IconButton, Input, Select, useMenu, type MenuEntry } from "./ui";
import { PAGE_ICONS, PageIcon, iconLabel } from "./icons";
import { useT } from "../lib/i18n";
import { LINK_COLORS, groupChoices, insertItem, isGroup, isPath, kindOf, moveItem, newGroup, removeItem, shortUrl, updateItem, type LinkKind } from "../lib/quicklinks";

/** An icon that fits the address when none was picked. */
export function guessIcon(url: string, kind: LinkKind = "link"): string {
  if (kind === "group") return "folder";
  if (kind === "app") return "app-window";
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

/** The icon a ribbon entry shows. */
export const iconOf = (l: QuickLink) => l.icon || guessIcon(l.url, kindOf(l));

/** The picked icon among the page icons (German names as labels). */
function IconGrid({ value, onPick, label }: { value: string; onPick: (name: string) => void; label: string }) {
  return (
    <div className="icon-picker inline" role="listbox" aria-label={label}>
      {Object.entries(PAGE_ICONS).map(([name, Icon]) => (
        <button key={name} type="button" role="option" aria-selected={value === name} aria-label={iconLabel(name)} title={iconLabel(name)} className={value === name ? "on" : ""} onClick={() => onPick(name)}>
          <Icon size={16} strokeWidth={1.75} />
        </button>
      ))}
    </div>
  );
}

/** Link, App or Gruppe (only while adding). */
function KindSwitch({ value, kinds, onChange }: { value: LinkKind; kinds: LinkKind[]; onChange: (k: LinkKind) => void }) {
  const t = useT();
  const meta: Record<LinkKind, { label: string; icon: LucideIcon }> = {
    link: { label: t("links.kindLink"), icon: Link2 },
    app: { label: t("links.kindApp"), icon: AppWindow },
    group: { label: t("links.kindGroup"), icon: FolderClosed },
  };
  return (
    <div className="segmented link-kind" role="radiogroup" aria-label={t("links.kind")}>
      {kinds.map((k) => {
        const M = meta[k];
        return (
          <button key={k} type="button" role="radio" aria-checked={value === k} className={value === k ? "on" : ""} data-kind={k} onClick={() => onChange(k)}>
            <M.icon size={14} strokeWidth={1.75} aria-hidden />
            {M.label}
          </button>
        );
      })}
    </div>
  );
}

export type EntryEdit =
  /** A link or app: new (`at` null) or the one at `at`; `group` is where it goes. */
  | { kind: "item"; at: { group: number | null; index: number } | null; link: QuickLink; group: number | null; allowGroup: boolean }
  /** A group: new (`index` null) or the one at `index`. */
  | { kind: "group"; index: number | null };

/**
 * The dialog behind „App / Link hinzufügen“ and „Bearbeiten“. Works on a copy of all links and
 * hands the whole new list to `onSave` (moves between groups change more than one place).
 */
export function EntryDialog({ links, edit, onClose, onSave }: { links: QuickLink[]; edit: EntryEdit; onClose: () => void; onSave: (next: QuickLink[]) => void }) {
  const t = useT();
  const [kind, setKind] = useState<LinkKind>(edit.kind === "group" ? "group" : kindOf(edit.link));
  const isNew = edit.kind === "group" ? edit.index === null : edit.at === null;
  // Link/app state.
  const initial = edit.kind === "item" ? edit.link : { name: "", url: "", icon: "" };
  const [link, setLink] = useState<QuickLink>(initial);
  const [iconTouched, setIconTouched] = useState(!!initial.icon);
  const [group, setGroup] = useState<number | null>(edit.kind === "item" ? edit.group : null);
  // Group state: a draft of all links with the group in it.
  const [draft, setDraft] = useState<{ links: QuickLink[]; gi: number }>(() =>
    edit.kind === "group" && edit.index !== null ? { links, gi: edit.index } : { links: [...links, newGroup("")], gi: links.length },
  );

  const itemKinds: LinkKind[] = isNew && edit.kind === "item" && edit.allowGroup ? ["link", "app", "group"] : ["link", "app"];
  const g = draft.links[draft.gi];
  const valid = kind === "group" ? g.name.trim().length > 0 : link.url.trim().length > 0;
  const title =
    kind === "group" ? (isNew ? t("links.newGroup") : t("links.editGroup")) : isNew ? t("links.addAny") : kind === "app" ? t("links.editApp") : t("links.edit");

  const submit = () => {
    if (!valid) return;
    if (kind === "group") return onSave(draft.links.map((l, i) => (i === draft.gi ? { ...l, name: l.name.trim() } : l)));
    const item: QuickLink = { name: link.name, url: link.url, icon: iconTouched ? link.icon : guessIcon(link.url, kind) };
    if (kind === "app") item.kind = "app";
    if (edit.kind !== "item") return;
    if (!edit.at) return onSave(insertItem(links, item, group));
    const updated = updateItem(links, edit.at, item);
    if (group === edit.at.group) return onSave(updated);
    const end = group === null ? updated.length : (updated[group]?.items?.length ?? 0);
    onSave(moveItem(updated, edit.at, { group, index: end }));
  };

  const groups = groupChoices(links);
  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      width={kind === "group" ? 540 : 480}
      description={kind === "group" ? t("links.helpGroup") : kind === "app" ? t("links.helpApp") : t("links.help")}
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
        className={`link-form ${kind === "group" ? "group-form" : ""}`}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {edit.kind === "item" && <KindSwitch value={kind} kinds={itemKinds} onChange={setKind} />}
        {kind === "group" ? (
          <GroupFields draft={draft} setDraft={setDraft} />
        ) : (
          <ItemFields
              link={link}
              kind={kind}
              setLink={setLink}
              onIcon={(name) => {
                setIconTouched(true);
                setLink({ ...link, icon: name });
              }}
            >
              {groups.length > 0 && edit.kind === "item" && (
                <Field label={t("links.inGroup")}>
                  <Select
                    className="link-group-select"
                    aria-label={t("links.inGroup")}
                    value={group === null ? "" : String(group)}
                    onChange={(e) => setGroup(e.target.value === "" ? null : Number(e.target.value))}
                    options={[{ value: "", label: t("links.noGroup") }, ...groups.map((c) => ({ value: String(c.index), label: c.name, icon: FolderClosed }))]}
                  />
                </Field>
              )}
            </ItemFields>
        )}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

/** Name, icon, color and the entries of the group `draft.links[draft.gi]`. */
function GroupFields({ draft, setDraft }: { draft: { links: QuickLink[]; gi: number }; setDraft: (d: { links: QuickLink[]; gi: number }) => void }) {
  const t = useT();
  const { links, gi } = draft;
  const g = links[gi];
  const items = g.items ?? [];
  const [sub, setSub] = useState<{ index: number | null; link: QuickLink } | null>(null);
  const [drag, setDrag] = useState<{ from: number; dy: number; to: number } | null>(null);
  const [menu, , openMenuAt] = useMenu();
  const list = useRef<HTMLDivElement>(null);
  const setGroup = (patch: Partial<QuickLink>) => setDraft({ links: links.map((l, i) => (i === gi ? { ...l, ...patch } : l)), gi });
  const at = (index: number) => ({ group: gi, index });
  const move = (from: number, to: number) => setDraft({ links: moveItem(links, at(from), at(to)), gi });
  const focusRow = (i: number) => setTimeout(() => list.current?.querySelector<HTMLElement>(`[data-row="${i}"]`)?.focus(), 0);
  // Ribbon entries that could move in (not groups).
  const loose = links.flatMap((l, index) => (index !== gi && !isGroup(l) ? [{ index, l }] : []));

  const moveMenu = (i: number): MenuEntry[] => [
    { label: t("links.ribbon"), icon: ArrowRightLeft, onSelect: () => setDraft({ links: moveItem(links, at(i), { group: null, index: links.length }), gi }) },
    ...groupChoices(links)
      .filter((c) => c.index !== gi)
      .map((c) => ({ label: c.name, icon: FolderClosed, onSelect: () => setDraft({ links: moveItem(links, at(i), { group: c.index, index: links[c.index].items?.length ?? 0 }), gi }) })),
  ];

  const onGripDown = (e: ReactPointerEvent<HTMLElement>, from: number) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button:not(.group-item-grip)")) return;
    const y0 = e.clientY;
    const rows = [...(list.current?.querySelectorAll<HTMLElement>(".group-item") ?? [])].map((r) => r.getBoundingClientRect());
    let cur: { from: number; dy: number; to: number } | null = null;
    const onMove = (ev: PointerEvent) => {
      if (!cur && Math.abs(ev.clientY - y0) < 4) return;
      const to = rows.findIndex((r) => ev.clientY < r.top + r.height / 2);
      cur = { from, dy: ev.clientY - y0, to: to < 0 ? rows.length : to };
      setDrag(cur);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setDrag(null);
      if (cur && cur.to !== cur.from && cur.to !== cur.from + 1) move(cur.from, cur.to);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <>
      <div className="group-head-fields">
        <Field label={t("links.groupName")}>
          <Input value={g.name} onChange={(e) => setGroup({ name: e.target.value })} placeholder={t("links.groupPlaceholder")} data-autofocus />
        </Field>
        <div className="field">
          <span className="field-label">{t("links.color")}</span>
          <div className="link-colors" role="radiogroup" aria-label={t("links.color")}>
            <button type="button" role="radio" aria-checked={!g.color} aria-label={t("links.noColor")} title={t("links.noColor")} className="link-color none" onClick={() => setGroup({ color: undefined })} />
            {LINK_COLORS.map((c) => (
              <button key={c.id} type="button" role="radio" aria-checked={g.color === c.id} aria-label={c.label} title={c.label} className="link-color" style={{ background: c.hex }} onClick={() => setGroup({ color: c.id })} />
            ))}
          </div>
        </div>
      </div>
      <div className="field">
        <span className="field-label">{t("links.icon")}</span>
        <IconGrid value={g.icon || "folder"} label={t("links.icon")} onPick={(name) => setGroup({ icon: name })} />
      </div>
      <div className="field">
        <span className="field-label">
          {t("links.items")} <span className="faint">· {t("links.itemsHelp")}</span>
        </span>
        <div className={`group-items${drag ? " dragging" : ""}`} ref={list} role="list" aria-label={t("links.items")}>
          {items.length === 0 && <div className="group-items-empty faint">{t("links.itemsEmpty")}</div>}
          {items.map((l, i) => (
            <div
              key={`${i}-${l.url}`}
              role="listitem"
              tabIndex={0}
              data-row={i}
              aria-label={l.name}
              className={`group-item${drag?.from === i ? " drag-src" : ""}${drag && drag.to === i && drag.from !== i && drag.from + 1 !== i ? " drop-before" : ""}${drag && drag.to === items.length && i === items.length - 1 && drag.from !== i ? " drop-after" : ""}`}
              style={drag?.from === i ? { transform: `translateY(${drag.dy}px)` } : undefined}
              onPointerDown={(e) => onGripDown(e, i)}
              onDoubleClick={() => setSub({ index: i, link: l })}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget) return;
                if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
                  e.preventDefault();
                  const to = e.key === "ArrowUp" ? i - 1 : i + 2;
                  if (to < 0 || to > items.length) return;
                  move(i, to);
                  focusRow(e.key === "ArrowUp" ? i - 1 : i + 1);
                } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                  e.preventDefault();
                  focusRow(Math.max(0, Math.min(items.length - 1, i + (e.key === "ArrowUp" ? -1 : 1))));
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  setSub({ index: i, link: l });
                } else if (e.key === "Delete" || e.key === "Backspace") {
                  e.preventDefault();
                  setDraft({ links: removeItem(links, at(i)), gi });
                  focusRow(Math.min(i, items.length - 2));
                }
              }}
            >
              <span className="group-item-grip" aria-hidden>
                <GripVertical size={14} />
              </span>
              <span className="group-item-icon">
                <PageIcon name={l.icon || guessIcon(l.url, kindOf(l))} size={15} />
              </span>
              <span className="group-item-text">
                <span className="group-item-name">{l.name || l.url}</span>
                <span className="group-item-url">{shortUrl(l.url)}</span>
              </span>
              <IconButton icon={Pencil} label={t("links.edit")} size="sm" onClick={() => setSub({ index: i, link: l })} />
              <IconButton icon={ArrowRightLeft} label={t("links.moveTo")} size="sm" onClick={(e) => openMenuAt(e, moveMenu(i))} />
              <IconButton icon={X} label={t("links.remove")} size="sm" onClick={() => setDraft({ links: removeItem(links, at(i)), gi })} />
            </div>
          ))}
        </div>
        <div className="group-items-actions">
          <Button size="sm" icon={Plus} onClick={() => setSub({ index: null, link: { name: "", url: "", icon: "" } })}>
            {t("links.add")}
          </Button>
          <Button size="sm" icon={AppWindow} onClick={() => setSub({ index: null, link: { name: "", url: "", icon: "", kind: "app" } })}>
            {t("links.addApp")}
          </Button>
          {loose.length > 0 && (
            <Select
              className="group-take-over"
              aria-label={t("links.takeOver")}
              value=""
              placeholder={t("links.takeOver")}
              onChange={(e) => {
                const index = Number(e.target.value);
                const next = moveItem(links, { group: null, index }, { group: gi, index: items.length });
                setDraft({ links: next, gi: index < gi ? gi - 1 : gi });
              }}
              options={loose.map(({ index, l }) => ({ value: String(index), label: l.name || l.url }))}
            />
          )}
        </div>
      </div>
      {menu}
      {sub && (
        <ItemDialog
          initial={sub.link}
          isNew={sub.index === null}
          onClose={() => setSub(null)}
          onSave={(item) => {
            const next = sub.index === null ? insertItem(links, item, gi) : updateItem(links, at(sub.index), item);
            setDraft({ links: next, gi });
            setSub(null);
          }}
        />
      )}
    </>
  );
}

/** A link or app inside the group dialog (the group is already chosen). */
function ItemDialog({ initial, isNew, onClose, onSave }: { initial: QuickLink; isNew: boolean; onClose: () => void; onSave: (l: QuickLink) => void }) {
  const t = useT();
  const [link, setLink] = useState(initial);
  const [iconTouched, setIconTouched] = useState(!!initial.icon);
  const kind = kindOf(link);
  const valid = link.url.trim().length > 0;
  const submit = () => {
    if (!valid) return;
    const out: QuickLink = { name: link.name, url: link.url, icon: iconTouched ? link.icon : guessIcon(link.url, kind) };
    if (kind === "app") out.kind = "app";
    onSave(out);
  };
  const label = kind === "app" ? (isNew ? t("links.addApp") : t("links.editApp")) : isNew ? t("links.add") : t("links.edit");
  return (
    <Dialog
      open
      onClose={onClose}
      title={label}
      description={kind === "app" ? t("links.helpApp") : t("links.help")}
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
        className="link-form item-form"
        onSubmit={(e) => {
          // Rendered inside the group dialog's form (through a portal): its submit must not bubble there.
          e.preventDefault();
          e.stopPropagation();
          submit();
        }}
      >
        <KindSwitch value={kind} kinds={["link", "app"]} onChange={(k) => setLink({ ...link, kind: k === "app" ? "app" : undefined })} />
        <ItemFields
          link={link}
          kind={kind}
          setLink={setLink}
          onIcon={(name) => {
            setIconTouched(true);
            setLink({ ...link, icon: name });
          }}
        />
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

/** Address (with „Auswählen …“ for a program), name, `children` (e.g. „In Gruppe“) and icon. */
function ItemFields({ link, kind, setLink, onIcon, children }: { link: QuickLink; kind: LinkKind; setLink: (f: (l: QuickLink) => QuickLink) => void; onIcon: (name: string) => void; children?: ReactNode }) {
  const t = useT();
  const browse = async () => {
    const p = await openFileDialog({ multiple: false, directory: false }).catch(() => null);
    if (typeof p === "string") setLink((l) => ({ ...l, url: p, name: l.name || (p.split(/[\\/]/).pop() ?? p).replace(/\.(exe|app|lnk|desktop)$/i, "") }));
  };
  return (
    <>
      <Field label={kind === "app" ? t("links.program") : t("links.url")}>
        <div className="link-url-row">
          <Input
            value={link.url}
            onChange={(e) => {
              const url = e.target.value;
              setLink((l) => ({ ...l, url }));
            }}
            placeholder={kind === "app" ? "C:\\Programme\\Tool\\tool.exe · /Applications/Tool.app" : "https://jira.firma.de · C:\\Projekte · mailto:team@firma.de"}
            data-autofocus
          />
          {kind === "app" && <Button onClick={browse}>{t("links.browse")}</Button>}
        </div>
      </Field>
      <Field label={t("links.name")}>
        <Input
          value={link.name}
          onChange={(e) => {
            const name = e.target.value;
            setLink((l) => ({ ...l, name }));
          }}
          placeholder={t("links.namePlaceholder")}
        />
      </Field>
      {children}
      <div className="field">
        <span className="field-label">{t("links.icon")}</span>
        <IconGrid value={link.icon || guessIcon(link.url, kind)} label={t("links.icon")} onPick={onIcon} />
      </div>
    </>
  );
}
