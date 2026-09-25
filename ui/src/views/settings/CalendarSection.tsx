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
import { useT } from "../../lib/i18n";
import type { CalendarSettings, CalendarSourceInfo, CalendarStatus } from "../../lib/types";
import { Group, NumberInput, Row, StatusNote, Unfiltered, type SectionProps } from "./common";

const COLORS = ["#2563eb", "#0d9488", "#9333ea", "#ea580c", "#db2777", "#65a30d", "#0891b2", "#ca8a04"];
const COLOR_NAMES = ["Blau", "Petrol", "Violett", "Orange", "Pink", "Grün", "Cyan", "Gold"];

function SourceStatus({ src }: { src: CalendarSourceInfo }) {
  if (src.syncing) return <StatusNote tone="busy">Wird synchronisiert …</StatusNote>;
  const st = src.status;
  if (!src.enabled) return <StatusNote>Ausgeschaltet</StatusNote>;
  if (st?.error) return <StatusNote tone="danger">{st.error}</StatusNote>;
  if (st?.synced_at)
    return (
      <StatusNote tone="success">
        {st.events} {st.events === 1 ? "Termin" : "Termine"} · synchronisiert {relative(st.synced_at)}
      </StatusNote>
    );
  return <StatusNote>Noch nicht synchronisiert</StatusNote>;
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
      s().error("Kalender", e);
      api.calendarStatus().then(setStatus).catch(() => {});
    } finally {
      setBusy(false);
    }
  };

  const outlook = status?.sources.find((x) => x.kind === "outlook");
  const ics = status?.sources.filter((x) => x.kind !== "outlook") ?? [];

  const sourceMenu = (src: CalendarSourceInfo) => [
    { label: "Jetzt synchronisieren", icon: RefreshCw, onSelect: () => void run(() => api.calendarSyncNow(src.id)) },
    { label: src.kind === "url" ? "Name oder Adresse ändern" : "Name oder Datei ändern", icon: Pencil, onSelect: () => setEditing(src) },
    {
      label: "Farbe",
      icon: Palette,
      submenu: COLORS.map((c, i) => ({ label: COLOR_NAMES[i], checked: c === src.color, onSelect: () => void run(() => api.calendarSourceUpdate(src.id, { color: c })) })),
    },
    "separator" as const,
    {
      label: "Entfernen",
      icon: Trash2,
      danger: true,
      onSelect: async () => {
        if (!(await s().confirm({ title: `„${src.name}“ entfernen?`, message: "Der Kalender und seine Termine werden aus Annalo entfernt; gebuchte Zeiten und Besprechungsnotizen bleiben.", confirmLabel: "Entfernen", danger: true }))) return;
        void run(() => api.calendarSourceRemove(src.id), "Kalender entfernt");
      },
    },
  ];

  return (
    <>
      <header className="settings-head">
        <h1>{t("nav.calendar")}</h1>
        <p>Termine aus Outlook und ICS-Kalendern erscheinen im Kalender neben der gebuchten Zeit und lassen sich mit einem Klick buchen. Sie bleiben auf diesem Computer; der KI-Assistent sieht sie nicht.</p>
      </header>

      {status?.outlook_available && (
        <Group title="Outlook (klassisch)" description="Liest den Standardkalender des Outlook, das auf diesem Computer angemeldet ist – ohne Administratorrechte und ohne App-Registrierung. Das neue Outlook erlaubt das nicht; dafür unten eine ICS-Adresse abonnieren.">
          <Row label="Outlook-Kalender lesen" description="Über die Programmierschnittstelle von Outlook (COM) per PowerShell. Beim ersten Mal startet Outlook gegebenenfalls im Hintergrund.">
            <Switch label="Outlook-Kalender lesen" checked={cal.outlook} onChange={(v) => set({ outlook: v })} />
          </Row>
          {cal.outlook && outlook && (
            <Row label="Status" keywords="Outlook Synchronisierung">
              <div className="calset-status">
                <SourceStatus src={outlook} />
                <Button size="sm" icon={RefreshCw} loading={outlook.syncing} onClick={() => void run(() => api.calendarSyncNow("outlook"), "Outlook synchronisiert")}>
                  Jetzt synchronisieren
                </Button>
              </div>
            </Row>
          )}
        </Group>
      )}

      <Group title="ICS-Kalender" description="Abonnierte Kalender (veröffentlichter Outlook- oder Exchange-Kalender, Google, Nextcloud …) und .ics-Dateien. Sie werden bei jeder Synchronisierung neu gelesen.">
        <Unfiltered>
          <div className="calset-list" aria-label="ICS-Kalender">
            {ics.length === 0 && <div className="calset-empty faint">Noch kein ICS-Kalender.</div>}
            {ics.map((src) => (
              <div key={src.id} className={`calset-item ${src.enabled ? "" : "off"}`} data-source={src.id}>
                <span className="calset-color" style={{ background: src.color }} aria-hidden />
                <div className="calset-text">
                  <div className="calset-name">
                    {src.kind === "url" ? <Link2 size={13} aria-hidden /> : <FileUp size={13} aria-hidden />}
                    <span className="ellipsis">{src.name}</span>
                  </div>
                  <div className="calset-where faint mono ellipsis" title={src.kind === "file" ? src.path : undefined}>
                    {src.kind === "url" ? (src.url_set ? src.address : "Keine Adresse gespeichert") : src.path}
                  </div>
                  <SourceStatus src={src} />
                </div>
                <Switch label={`${src.name} synchronisieren`} checked={src.enabled} onChange={(v) => void run(() => api.calendarSourceUpdate(src.id, { enabled: v }))} />
                <IconButton icon={MoreHorizontal} label={`Aktionen für ${src.name}`} onClick={(e) => openMenuAt(e, sourceMenu(src))} />
              </div>
            ))}
          </div>
          <div className="calset-add">
            <Button icon={Link2} onClick={() => setAdding("url")} disabled={busy}>
              ICS-Adresse abonnieren
            </Button>
            <Button icon={FileUp} variant="ghost" onClick={() => setAdding("file")} disabled={busy}>
              .ics-Datei einbinden
            </Button>
          </div>
          <p className="calset-note faint">Abo-Adressen enthalten oft einen geheimen Schlüssel. Annalo speichert sie deshalb in: {status?.secret_storage ?? "dem Anmeldeinformationsspeicher"}, nicht in den Einstellungen und nicht in Exporten.</p>
        </Unfiltered>
      </Group>

      <Group title="Synchronisierung">
        <Row label="Intervall" description="So oft liest Annalo die Kalender im Hintergrund neu.">
          <div className="unit-input">
            <NumberInput min={5} max={1440} value={cal.sync_minutes} onCommit={(v) => set({ sync_minutes: v })} aria-label="Minuten" />
            <span className="faint">Minuten</span>
          </div>
        </Row>
        <Row label="Zeitraum" description="Tage zurück und voraus, die bei jeder Synchronisierung gelesen werden.">
          <div className="calset-window">
            <div className="unit-input">
              <NumberInput min={1} max={365} value={cal.past_days} onCommit={(v) => set({ past_days: v })} aria-label="Tage zurück" />
              <span className="faint">zurück</span>
            </div>
            <div className="unit-input">
              <NumberInput min={1} max={365} value={cal.future_days} onCommit={(v) => set({ future_days: v })} aria-label="Tage voraus" />
              <span className="faint">voraus</span>
            </div>
          </div>
        </Row>
        <Row label="Alle Kalender jetzt synchronisieren">
          <Button icon={RefreshCw} loading={busy} onClick={() => void run(() => api.calendarSyncNow(), "Kalender synchronisiert")}>
            Jetzt synchronisieren
          </Button>
        </Row>
      </Group>

      <Group title="Datenschutz" description="Was von einem Termin übernommen wird. Änderungen gelten ab der nächsten Synchronisierung.">
        <Row label="Details privater Termine" description="Aus: private Termine erscheinen nur als „Privater Termin“ mit ihrer Zeit.">
          <Switch label="Details privater Termine" checked={cal.private_details} onChange={(v) => set({ private_details: v })} />
        </Row>
        <Row label="Termintext übernehmen" description="Die Beschreibung eines Termins (Agenda, Einwahldaten). Standardmäßig aus.">
          <Switch label="Termintext übernehmen" checked={cal.include_body} onChange={(v) => set({ include_body: v })} />
        </Row>
        <Row label="Besprechungslinks" description="Den Teams-, Zoom- oder Webex-Link aus dem Termin übernehmen (nur den Link, nicht den Text).">
          <Switch label="Besprechungslinks" checked={cal.meeting_links} onChange={(v) => set({ meeting_links: v })} />
        </Row>
      </Group>

      <Unfiltered>
        <details className="calset-help">
          <summary>So kommen Termine in Annalo</summary>
          <ul>
            <li>
              <b>Outlook (klassisch) unter Windows:</b> „Outlook-Kalender lesen“ einschalten. Outlook muss eingerichtet sein; es darf nicht als Administrator laufen. Fragt Outlook „Ein Programm versucht, auf E-Mail-Adressinformationen zuzugreifen“, den Zugriff erlauben.
            </li>
            <li>
              <b>Outlook im Web / Exchange:</b> Einstellungen → Kalender → Freigegebene Kalender → „Kalender veröffentlichen“, Details wählen, den ICS-Link kopieren und hier mit „ICS-Adresse abonnieren“ einfügen.
            </li>
            <li>
              <b>Google Kalender:</b> Einstellungen des Kalenders → „Privatadresse im iCal-Format“ kopieren und abonnieren.
            </li>
            <li>
              <b>Einmalig oder ohne Netz:</b> In Outlook „Datei → Kalender speichern“ als .ics und die Datei einbinden; Annalo liest sie bei jeder Synchronisierung neu.
            </li>
          </ul>
        </details>
      </Unfiltered>

      {menu}
      {adding && <AddSourceDialog kind={adding} onClose={() => setAdding(null)} onAdd={(name, src) => run(() => api.calendarSourceAdd(name, src), "Kalender hinzugefügt").then(() => setAdding(null))} />}
      {editing && (
        <EditSourceDialog
          src={editing}
          onClose={() => setEditing(null)}
          onSave={(patch) => run(() => api.calendarSourceUpdate(editing.id, patch), "Gespeichert").then(() => setEditing(null))}
        />
      )}
    </>
  );
}

async function pickIcs(): Promise<string | null> {
  const r = await openDialog({ multiple: false, directory: false, title: "Kalenderdatei wählen", filters: [{ name: "iCalendar", extensions: ["ics", "ical", "ifb", "icalendar"] }] });
  return typeof r === "string" ? r : null;
}

const fileName = (p: string) => p.split(/[\\/]/).pop()?.replace(/\.(ics|ical|icalendar)$/i, "") ?? "";

function AddSourceDialog({ kind, onClose, onAdd }: { kind: "url" | "file"; onClose: () => void; onAdd: (name: string, src: { url?: string; path?: string }) => Promise<void> }) {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const url = kind === "url";
  const valid = url ? /^(https?|webcals?):\/\/\S+$/i.test(value.trim()) : value.trim().length > 0;
  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    const n = name.trim() || (url ? "Kalender" : fileName(value.trim()) || "Kalender");
    await onAdd(n, url ? { url: value.trim() } : { path: value.trim() });
    setBusy(false);
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={url ? "ICS-Adresse abonnieren" : ".ics-Datei einbinden"}
      description={url ? "Die Adresse wird im Anmeldeinformationsspeicher abgelegt, nicht in den Einstellungen." : "Die Datei wird bei jeder Synchronisierung neu gelesen."}
      width={520}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
          <Button variant="primary" onClick={() => void submit()} loading={busy} disabled={!valid}>
            Hinzufügen
          </Button>
        </>
      }
    >
      <Field label={url ? "Adresse" : "Datei"} hint={url ? "https://…/calendar.ics oder webcal://…" : undefined}>
        {url ? (
          <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder="https://outlook.office365.com/owa/calendar/…/calendar.ics" spellCheck={false} data-autofocus onKeyDown={(e) => e.key === "Enter" && void submit()} />
        ) : (
          <div className="calset-file">
            <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder="C:\Users\…\Kalender.ics" spellCheck={false} data-autofocus onKeyDown={(e) => e.key === "Enter" && void submit()} />
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
              Durchsuchen …
            </Button>
          </div>
        )}
      </Field>
      <Field label="Name">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={url ? "z. B. Team-Kalender" : "z. B. Projektplan"} onKeyDown={(e) => e.key === "Enter" && void submit()} />
      </Field>
    </Dialog>
  );
}

function EditSourceDialog({ src, onClose, onSave }: { src: CalendarSourceInfo; onClose: () => void; onSave: (patch: { name?: string; url?: string; path?: string }) => Promise<void> }) {
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
      title="Kalender bearbeiten"
      width={520}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
          <Button variant="primary" onClick={submit}>
            Speichern
          </Button>
        </>
      }
    >
      <Field label="Name">
        <Input value={name} onChange={(e) => setName(e.target.value)} data-autofocus />
      </Field>
      <Field label={url ? "Neue Adresse" : "Datei"} hint={url ? `Leer lassen, um die gespeicherte Adresse (${src.address || "keine"}) zu behalten.` : undefined}>
        <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder={url ? "https://…" : ""} spellCheck={false} />
      </Field>
    </Dialog>
  );
}
