// Settings → Kalender: Outlook Classic (Windows), ICS subscriptions and files, sync interval and
// window, what private appointments keep. Subscription addresses go to the credential store;
// the sources are saved by their own commands, the other rows with the settings.

import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { FileUp, FolderOpen, Link2, MoreHorizontal, Palette, Pencil, RefreshCw, Trash2 } from "lucide-react";
import { api, on } from "../../lib/api";
import { useApp } from "../../store/app";
import { relative } from "../../lib/format";
import { Button, Dialog, Field, IconButton, Input, Switch, useMenu } from "../../components/ui";
import { t, useT, type TKey } from "../../lib/i18n";
import type { CalendarSettings, CalendarSourceInfo, CalendarStatus } from "../../lib/types";
import { MailGroup } from "./MailGroup";
import { Group, NumberInput, Row, StatusNote, Unfiltered, type SectionProps } from "./common";

const COLORS = ["#2563eb", "#0d9488", "#9333ea", "#ea580c", "#db2777", "#65a30d", "#0891b2", "#ca8a04"];
const COLOR_NAMES: TKey[] = ["calset.color.blue", "calset.color.petrol", "calset.color.violet", "calset.color.orange", "calset.color.pink", "calset.color.green", "calset.color.cyan", "calset.color.gold"];

function SourceStatus({ src }: { src: CalendarSourceInfo }) {
  const t = useT();
  if (src.syncing) return <StatusNote tone="busy">{t("calset.syncing")}</StatusNote>;
  const st = src.status;
  if (!src.enabled) return <StatusNote>{t("calset.off")}</StatusNote>;
  if (st?.error) return <StatusNote tone="danger">{st.error}</StatusNote>;
  if (st?.synced_at)
    return (
      <StatusNote tone="success">
        {t("calset.syncedEvents", { n: st.events, when: relative(st.synced_at) })}
      </StatusNote>
    );
  return <StatusNote>{t("calset.notSynced")}</StatusNote>;
}

export function CalendarSection({ draft, update }: SectionProps) {
  const t = useT();
  const cal = draft.calendar;
  const [status, setStatus] = useState<CalendarStatus | null>(null);
  const [adding, setAdding] = useState<"url" | "file" | null>(null);
  const [editing, setEditing] = useState<CalendarSourceInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [menu, , openMenuAt] = useMenu();
  const s = useApp.getState;
  const set = (p: Partial<CalendarSettings>) => update({ calendar: { ...cal, ...p } });

  useEffect(() => {
    const load = () => api.calendarStatus().then(setStatus).catch(() => {});
    load();
    const offs = [on("calendar://synced", load), on("calendar://syncing", load), on("settings://changed", load)];
    return () => offs.forEach((u) => u.then((f) => f()));
  }, []);

  const run = async (fn: () => Promise<CalendarStatus>, ok?: string) => {
    setBusy(true);
    try {
      setStatus(await fn());
      await s().refreshSettings();
      if (ok) s().toast({ tone: "success", title: ok });
    } catch (e) {
      s().error(t("nav.calendar"), e);
      api.calendarStatus().then(setStatus).catch(() => {});
    } finally {
      setBusy(false);
    }
  };

  const outlook = status?.sources.find((x) => x.kind === "outlook");
  const ics = status?.sources.filter((x) => x.kind !== "outlook") ?? [];

  const sourceMenu = (src: CalendarSourceInfo) => [
    { label: t("calset.syncNow"), icon: RefreshCw, onSelect: () => void run(() => api.calendarSyncNow(src.id)) },
    { label: src.kind === "url" ? t("calset.editUrl") : t("calset.editFile"), icon: Pencil, onSelect: () => setEditing(src) },
    {
      label: t("links.color"),
      icon: Palette,
      submenu: COLORS.map((c, i) => ({ label: t(COLOR_NAMES[i]), checked: c === src.color, onSelect: () => void run(() => api.calendarSourceUpdate(src.id, { color: c })) })),
    },
    "separator" as const,
    {
      label: t("common.remove"),
      icon: Trash2,
      danger: true,
      onSelect: async () => {
        if (!(await s().confirm({ title: t("calset.removeAsk", { name: src.name }), message: t("calset.removeText"), confirmLabel: t("common.remove"), danger: true }))) return;
        void run(() => api.calendarSourceRemove(src.id), t("calset.removed"));
      },
    },
  ];

  return (
    <>
      <header className="settings-head">
        <h1>{t("nav.calendar")}</h1>
        <p>{t("calset.intro")}</p>
      </header>

      {status?.outlook_available && (
        <Group title={t("calset.outlook")} description={t("calset.outlookDesc")}>
          <Row label={t("calset.outlookRead")} description={t("calset.outlookReadDesc")}>
            <Switch label={t("calset.outlookRead")} checked={cal.outlook} onChange={(v) => set({ outlook: v })} />
          </Row>
          {cal.outlook && outlook && (
            <Row label={t("upd.status")} keywords={t("calset.outlookKeywords")}>
              <div className="calset-status">
                <SourceStatus src={outlook} />
                <Button size="sm" icon={RefreshCw} loading={outlook.syncing} onClick={() => void run(() => api.calendarSyncNow("outlook"), t("calset.outlookSynced"))}>
                  {t("calset.syncNow")}
                </Button>
              </div>
            </Row>
          )}
        </Group>
      )}

      <Group title={t("calset.ics")} description={t("calset.icsDesc")}>
        <Unfiltered>
          <div className="calset-list" aria-label={t("calset.ics")}>
            {ics.length === 0 && <div className="calset-empty faint">{t("calset.icsNone")}</div>}
            {ics.map((src) => (
              <div key={src.id} className={`calset-item ${src.enabled ? "" : "off"}`} data-source={src.id}>
                <span className="calset-color" style={{ background: src.color }} aria-hidden />
                <div className="calset-text">
                  <div className="calset-name">
                    {src.kind === "url" ? <Link2 size={13} aria-hidden /> : <FileUp size={13} aria-hidden />}
                    <span className="ellipsis">{src.name}</span>
                  </div>
                  <div className="calset-where faint mono ellipsis" title={src.kind === "file" ? src.path : undefined}>
                    {src.kind === "url" ? (src.url_set ? src.address : t("calset.noAddress")) : src.path}
                  </div>
                  <SourceStatus src={src} />
                </div>
                <Switch label={t("calset.syncSource", { name: src.name })} checked={src.enabled} onChange={(v) => void run(() => api.calendarSourceUpdate(src.id, { enabled: v }))} />
                <IconButton icon={MoreHorizontal} label={t("calset.actionsFor", { name: src.name })} onClick={(e) => openMenuAt(e, sourceMenu(src))} />
              </div>
            ))}
          </div>
          <div className="calset-add">
            <Button icon={Link2} onClick={() => setAdding("url")} disabled={busy}>
              {t("calset.addUrl")}
            </Button>
            <Button icon={FileUp} variant="ghost" onClick={() => setAdding("file")} disabled={busy}>
              {t("calset.addFile")}
            </Button>
          </div>
          <p className="calset-note faint">{t("calset.secretNote", { store: status?.secret_storage ?? t("calset.secretStore") })}</p>
        </Unfiltered>
      </Group>

      <Group title={t("calset.sync")}>
        <Row label={t("calset.interval")} description={t("calset.intervalDesc")}>
          <div className="unit-input">
            <NumberInput min={5} max={1440} value={cal.sync_minutes} onCommit={(v) => set({ sync_minutes: v })} aria-label={t("unit.minutes")} />
            <span className="faint">{t("unit.minutes")}</span>
          </div>
        </Row>
        <Row label={t("calset.window")} description={t("calset.windowDesc")}>
          <div className="calset-window">
            <div className="unit-input">
              <NumberInput min={1} max={365} value={cal.past_days} onCommit={(v) => set({ past_days: v })} aria-label={t("calset.daysBack")} />
              <span className="faint">{t("calset.back")}</span>
            </div>
            <div className="unit-input">
              <NumberInput min={1} max={365} value={cal.future_days} onCommit={(v) => set({ future_days: v })} aria-label={t("calset.daysAhead")} />
              <span className="faint">{t("calset.ahead")}</span>
            </div>
          </div>
        </Row>
        <Row label={t("calset.syncAll")}>
          <Button icon={RefreshCw} loading={busy} onClick={() => void run(() => api.calendarSyncNow(), t("cal.synced"))}>
            {t("calset.syncNow")}
          </Button>
        </Row>
      </Group>

      <Group title={t("nav.privacy")} description={t("calset.privacyDesc")}>
        <Row label={t("calset.privateDetails")} description={t("calset.privateDetailsDesc")}>
          <Switch label={t("calset.privateDetails")} checked={cal.private_details} onChange={(v) => set({ private_details: v })} />
        </Row>
        <Row label={t("calset.body")} description={t("calset.bodyDesc")}>
          <Switch label={t("calset.body")} checked={cal.include_body} onChange={(v) => set({ include_body: v })} />
        </Row>
        <Row label={t("calset.links")} description={t("calset.linksDesc")}>
          <Switch label={t("calset.links")} checked={cal.meeting_links} onChange={(v) => set({ meeting_links: v })} />
        </Row>
      </Group>

      <MailGroup draft={draft} update={update} />

      <Unfiltered>
        <details className="calset-help">
          <summary>{t("calset.help")}</summary>
          <ul>
            <li>
              <b>{t("calset.help.outlook")}</b> {t("calset.help.outlookText")}
            </li>
            <li>
              <b>{t("calset.help.web")}</b> {t("calset.help.webText")}
            </li>
            <li>
              <b>{t("calset.help.google")}</b> {t("calset.help.googleText")}
            </li>
            <li>
              <b>{t("calset.help.file")}</b> {t("calset.help.fileText")}
            </li>
          </ul>
        </details>
      </Unfiltered>

      {menu}
      {adding && <AddSourceDialog kind={adding} onClose={() => setAdding(null)} onAdd={(name, src) => run(() => api.calendarSourceAdd(name, src), t("calset.added")).then(() => setAdding(null))} />}
      {editing && (
        <EditSourceDialog
          src={editing}
          onClose={() => setEditing(null)}
          onSave={(patch) => run(() => api.calendarSourceUpdate(editing.id, patch), t("common.savedTitle")).then(() => setEditing(null))}
        />
      )}
    </>
  );
}

async function pickIcs(): Promise<string | null> {
  const r = await openDialog({ multiple: false, directory: false, title: t("calset.pickFile"), filters: [{ name: "iCalendar", extensions: ["ics", "ical", "ifb", "icalendar"] }] });
  return typeof r === "string" ? r : null;
}

const fileName = (p: string) => p.split(/[\\/]/).pop()?.replace(/\.(ics|ical|icalendar)$/i, "") ?? "";

function AddSourceDialog({ kind, onClose, onAdd }: { kind: "url" | "file"; onClose: () => void; onAdd: (name: string, src: { url?: string; path?: string }) => Promise<void> }) {
  const t = useT();
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const url = kind === "url";
  const valid = url ? /^(https?|webcals?):\/\/\S+$/i.test(value.trim()) : value.trim().length > 0;
  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    const n = name.trim() || (url ? t("nav.calendar") : fileName(value.trim()) || t("nav.calendar"));
    await onAdd(n, url ? { url: value.trim() } : { path: value.trim() });
    setBusy(false);
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={url ? t("calset.addUrl") : t("calset.addFile")}
      description={url ? t("calset.addUrlDesc") : t("calset.addFileDesc")}
      width={520}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" onClick={() => void submit()} loading={busy} disabled={!valid}>
            {t("common.add")}
          </Button>
        </>
      }
    >
      <Field label={url ? t("links.url") : t("feed.kind.file")} hint={url ? t("calset.urlHint") : undefined}>
        {url ? (
          <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder="https://outlook.office365.com/owa/calendar/…/calendar.ics" spellCheck={false} data-autofocus onKeyDown={(e) => e.key === "Enter" && void submit()} />
        ) : (
          <div className="calset-file">
            <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder={t("calset.filePlaceholder")} spellCheck={false} data-autofocus onKeyDown={(e) => e.key === "Enter" && void submit()} />
            <Button
              icon={FolderOpen}
              onClick={async () => {
                const p = await pickIcs();
                if (p) {
                  setValue(p);
                  if (!name.trim()) setName(fileName(p));
                }
              }}
            >
              {t("links.browse")}
            </Button>
          </div>
        )}
      </Field>
      <Field label={t("links.name")}>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={url ? t("calset.namePlaceholderUrl") : t("calset.namePlaceholderFile")} onKeyDown={(e) => e.key === "Enter" && void submit()} />
      </Field>
    </Dialog>
  );
}

function EditSourceDialog({ src, onClose, onSave }: { src: CalendarSourceInfo; onClose: () => void; onSave: (patch: { name?: string; url?: string; path?: string }) => Promise<void> }) {
  const t = useT();
  const [name, setName] = useState(src.name);
  const [value, setValue] = useState(src.kind === "file" ? src.path : "");
  const url = src.kind === "url";
  const submit = () => {
    const patch: { name?: string; url?: string; path?: string } = { name: name.trim() || src.name };
    if (url && value.trim()) patch.url = value.trim();
    if (!url && value.trim() && value.trim() !== src.path) patch.path = value.trim();
    void onSave(patch);
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={t("calset.edit")}
      width={520}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" onClick={submit}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      <Field label={t("links.name")}>
        <Input value={name} onChange={(e) => setName(e.target.value)} data-autofocus />
      </Field>
      <Field label={url ? t("calset.newAddress") : t("feed.kind.file")} hint={url ? t("calset.keepAddress", { address: src.address || t("calset.none") }) : undefined}>
        <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder={url ? "https://…" : ""} spellCheck={false} />
      </Field>
    </Dialog>
  );
}
