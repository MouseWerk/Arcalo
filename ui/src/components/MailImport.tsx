// „E-Mail übernehmen“: a mail (from Outlook, a dropped .eml/.msg or a pasted header block)
// becomes a task, a note or both, linked back to the mail. The dialog lives here with its
// entry points: the palette, the global shortcut (`mail://capture`), files dropped anywhere
// on the window and the „E-Mail öffnen“ links in notes and the task list.

import { useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { ChevronLeft, ChevronRight, FileUp, Inbox, Mail as MailIcon, Paperclip, Sparkles, X } from "lucide-react";
import { on } from "../lib/api";
import { useApp } from "../store/app";
import { Badge, Button, Dialog, Field, IconButton, Input, Segmented, Select, TextArea, type SelectOption } from "./ui";
import { DateInput, dayLabel } from "./DateInput";
import { fileSize } from "../lib/format";
import { reloadEditors } from "../editor/NoteEditor";
import {
  DUE_CHOICES,
  cleanSubject,
  dueFor,
  isMailFile,
  looksLikeHeaderBlock,
  mailApi,
  offeredAttachments,
  preview,
  priorityFromImportance,
  senderLabel,
  type Mail,
  type MailImportRequest,
  type MailStatus,
  type TaskTarget,
} from "../lib/mail";

type Action = "task" | "note" | "both";

interface MailDialogState {
  open: boolean;
  mails: Mail[];
  index: number;
  busy: "outlook" | "file" | "paste" | null;
  error: string | null;
  set: (p: Partial<MailDialogState>) => void;
}

const useMailDialog = create<MailDialogState>((set) => ({
  open: false,
  mails: [],
  index: 0,
  busy: null,
  error: null,
  set: (p) => set(p),
}));

const d = useMailDialog.getState;

/** Opens the dialog (empty: choose a source; with mails: take them over one by one). */
export function openMailDialog(mails: Mail[] = []) {
  d().set({ open: true, mails, index: 0, busy: null, error: null });
}

/** „Aktuelle E-Mail übernehmen“: the mails selected or open in Outlook. */
export async function captureFromOutlook() {
  const st = d();
  if (!st.open) st.set({ open: true, mails: [], index: 0, error: null });
  d().set({ busy: "outlook", error: null });
  try {
    const mails = await mailApi.outlookCurrent();
    d().set({ mails, index: 0, busy: null });
  } catch (e) {
    d().set({ busy: null, error: String(e) });
  }
}

/** Dropped or chosen .eml/.msg files. */
export async function openMailFiles(files: File[]) {
  const list = files.filter((f) => isMailFile(f.name));
  if (!list.length) return;
  if (!d().open) d().set({ open: true, mails: [], index: 0 });
  d().set({ busy: "file", error: null });
  const mails: Mail[] = [];
  const errors: string[] = [];
  for (const f of list) {
    try {
      mails.push(await mailApi.parseFile(f));
    } catch (e) {
      errors.push(String(e));
    }
  }
  const before = d().mails;
  d().set({ mails: [...before, ...mails], index: before.length && mails.length ? before.length : d().index, busy: null, error: errors.length ? errors.join("\n") : null });
}

const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes("Files");

/** Mounted once in the main window: the dialog and its global entry points. */
export function MailImportHost() {
  const open = useMailDialog((st) => st.open);
  useEffect(() => {
    // Files dropped anywhere: mail files open the dialog before the editor or a pane embeds them.
    const onDrop = (e: DragEvent) => {
      const files = [...(e.dataTransfer?.files ?? [])];
      if (!files.length || !files.every((f) => isMailFile(f.name))) return;
      e.preventDefault();
      e.stopPropagation();
      void openMailFiles(files);
    };
    const onDragOver = (e: DragEvent) => {
      // Outlook's own drags carry no file here (virtual files); plain .eml/.msg files do.
      if (hasFiles(e) && [...(e.dataTransfer?.items ?? [])].some((i) => /message\/rfc822|vnd\.ms-outlook/.test(i.type))) e.preventDefault();
    };
    window.addEventListener("drop", onDrop, true);
    window.addEventListener("dragover", onDragOver, true);
    const off = on("mail://capture", () => void captureFromOutlook());
    return () => {
      window.removeEventListener("drop", onDrop, true);
      window.removeEventListener("dragover", onDragOver, true);
      void off.then((f) => f());
    };
  }, []);
  return open ? <MailDialog /> : null;
}

function MailDialog() {
  const { mails, index, busy, error, set } = useMailDialog();
  const [status, setStatus] = useState<MailStatus | null>(null);
  useEffect(() => void mailApi.status().then(setStatus, () => setStatus({ outlook_available: false, local_ai: null })), []);
  const close = () => set({ open: false, mails: [], index: 0, busy: null, error: null });
  const mail = mails[index] ?? null;
  const title = mails.length > 1 ? `E-Mail übernehmen (${index + 1} von ${mails.length})` : "E-Mail übernehmen";
  return (
    <Dialog open onClose={close} title={title} width={760} description={mail ? undefined : "Aus Outlook, einer .eml- oder .msg-Datei oder den kopierten Kopfzeilen einer E-Mail."}>
      <div className="mailx">
        {error && (
          <div className="mailx-error" role="alert">
            <span>{error}</span>
            <IconButton icon={X} label="Hinweis schließen" size="sm" onClick={() => set({ error: null })} />
          </div>
        )}
        {mail ? <MailForm key={`${index}-${mail.entry_id}-${mail.file}`} mail={mail} status={status} onDone={close} /> : <MailSources status={status} busy={busy} />}
      </div>
    </Dialog>
  );
}

/** Where a mail comes from, when none is loaded yet. */
function MailSources({ status, busy }: { status: MailStatus | null; busy: MailDialogState["busy"] }) {
  const [text, setText] = useState("");
  const [drop, setDrop] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const header = looksLikeHeaderBlock(text);
  const parse = async (value = text) => {
    d().set({ busy: "paste", error: null });
    try {
      const m = await mailApi.parseText(value);
      if (m) d().set({ mails: [m], index: 0, busy: null });
      else d().set({ busy: null, error: "Keine Kopfzeilen erkannt. Erwartet werden Zeilen wie „Von:“, „Gesendet:“, „An:“ und „Betreff:“ (oder „From:“, „Sent:“, „To:“, „Subject:“)." });
    } catch (e) {
      d().set({ busy: null, error: String(e) });
    }
  };
  return (
    <div className="mailx-sources">
      <div className="mailx-source-row">
        <div className="mailx-source">
          <div className="mailx-source-head">
            <Inbox size={16} aria-hidden /> Outlook (klassisch)
          </div>
          <p className="faint">Übernimmt die in Outlook markierten E-Mails oder die geöffnete E-Mail.</p>
          <Button variant="primary" icon={MailIcon} loading={busy === "outlook"} disabled={!status?.outlook_available || !!busy} onClick={() => void captureFromOutlook()} className="mailx-outlook">
            Aktuelle E-Mail übernehmen
          </Button>
          {status && !status.outlook_available && <p className="faint mailx-small">Nur unter Windows mit Outlook (klassisch).</p>}
        </div>
        <div
          className={`mailx-source mailx-drop ${drop ? "over" : ""}`}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes("Files")) return;
            e.preventDefault();
            setDrop(true);
          }}
          onDragLeave={() => setDrop(false)}
          onDrop={() => setDrop(false)}
        >
          <div className="mailx-source-head">
            <FileUp size={16} aria-hidden /> Datei
          </div>
          <p className="faint">.eml- oder .msg-Dateien hierher oder irgendwo ins Fenster ziehen.</p>
          <Button icon={FileUp} loading={busy === "file"} disabled={!!busy} onClick={() => picker.current?.click()}>
            Datei wählen…
          </Button>
          <input
            ref={picker}
            type="file"
            accept=".eml,.msg"
            multiple
            hidden
            onChange={(e) => {
              const files = [...(e.target.files ?? [])];
              e.target.value = "";
              void openMailFiles(files);
            }}
          />
        </div>
      </div>
      <Field label="Kopfzeilen einfügen" hint="Aus einer weitergeleiteten oder kopierten E-Mail: „Von:“, „Gesendet:“, „An:“, „Betreff:“ und darunter der Text.">
        <TextArea
          className="mailx-paste"
          rows={5}
          value={text}
          placeholder={"Von: Müller, Anna <anna.mueller@example.com>\nGesendet: Donnerstag, 24. September 2026 14:32\nAn: …\nBetreff: …"}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const pasted = e.clipboardData.getData("text/plain");
            if (looksLikeHeaderBlock(pasted)) {
              e.preventDefault();
              setText(pasted);
              void parse(pasted);
            }
          }}
          aria-label="Kopfzeilen einer E-Mail"
        />
      </Field>
      <div className="mailx-paste-foot">
        <p className="faint mailx-small">
          Direkt aus Outlook gezogene E-Mails kommen nur als virtuelle Dateien an, die Annalo nicht lesen kann. Dafür die E-Mail in Outlook markieren und „Aktuelle E-Mail übernehmen“ wählen (Tastenkürzel unter Einstellungen → Kalender) oder sie als Datei speichern.
        </p>
        <Button disabled={!header || !!busy} loading={busy === "paste"} onClick={() => void parse()}>
          Kopfzeilen lesen
        </Button>
      </div>
    </div>
  );
}

const dateTime = (iso: string) =>
  new Date(iso).toLocaleString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

function MailForm({ mail, status, onDone }: { mail: Mail; status: MailStatus | null; onDone: () => void }) {
  const s = useApp.getState;
  const settings = useApp((st) => st.settings?.settings.mail);
  const pages = useApp((st) => st.pages);
  const activeTab = useApp((st) => st.tabs.find((t) => t.id === st.activeTabId) ?? null);
  const current = activeTab?.kind === "page" && activeTab.pageId != null ? pages.get(activeTab.pageId) ?? null : null;
  const [action, setAction] = useState<Action>(settings?.default_action ?? "task");
  const [taskText, setTaskText] = useState(cleanSubject(mail.subject) || "E-Mail beantworten");
  const [target, setTarget] = useState<string>(current ? "current" : "daily");
  const [due, setDue] = useState("");
  const [priority, setPriority] = useState(String(priorityFromImportance(mail.importance)));
  const [noteTitle, setNoteTitle] = useState(cleanSubject(mail.subject) || mail.subject);
  const [parent, setParent] = useState(settings?.notes_parent || "E-Mails");
  const [vorgang, setVorgang] = useState("");
  const [useTags, setUseTags] = useState(false);
  const [withInline, setWithInline] = useState(false);
  const offered = offeredAttachments(mail, withInline);
  const [picked, setPicked] = useState<Set<number>>(() => new Set(settings?.save_attachments ? offeredAttachments(mail, false).map((a) => a.index) : []));
  const [saving, setSaving] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const { mails, index } = useMailDialog();
  const withTask = action !== "note";
  const withNote = action !== "task";
  const inlineCount = mail.attachments.filter((a) => a.inline).length;
  const canAttach = mail.source !== "text";

  useEffect(() => {
    if (target === "note" && !withNote) setTarget(current ? "current" : "daily");
  }, [withNote, target, current]);

  const targetOptions = useMemo<SelectOption[]>(() => {
    const out: SelectOption[] = [];
    if (current) out.push({ value: "current", label: `Aktuelle Seite: ${current.title}` });
    out.push({ value: "daily", label: "Tagesnotiz (heute)" });
    if (withNote) out.push({ value: "note", label: "In die neue Notiz" });
    const others = [...pages.values()]
      .filter((p) => !p.deleted_at && p.id !== current?.id)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, 400);
    others.forEach((p, i) => out.push({ value: `page:${p.id}`, label: p.title, group: i === 0 ? "Andere Seite" : undefined }));
    return out;
  }, [pages, current, withNote]);

  const suggest = async () => {
    setSuggesting(true);
    try {
      const r = await mailApi.suggest(`mail-${Date.now()}`, mail);
      setTaskText(r.task);
      if (r.due) setDue(r.due);
      if (action === "note") setAction("both");
    } catch (e) {
      s().error("Kein Vorschlag", e);
    } finally {
      setSuggesting(false);
    }
  };

  const taskTarget = (): TaskTarget => {
    if (target === "current" && current) return { kind: "page", id: current.id };
    if (target === "note") return { kind: "note" };
    if (target.startsWith("page:")) return { kind: "page", id: Number(target.slice(5)) };
    return { kind: "daily" };
  };

  const submit = async () => {
    const request: MailImportRequest = {
      mail,
      task: withTask ? { target: taskTarget(), text: taskText.trim(), due: due || null, priority: Number(priority) } : null,
      note: withNote ? { parent: parent.trim(), title: noteTitle.trim() } : null,
      vorgang: vorgang.trim(),
      tags: useTags ? mail.categories : [],
      attachments: canAttach ? [...picked].sort((a, b) => a - b) : [],
    };
    setSaving(true);
    try {
      const out = await mailApi.import(request);
      await s().refreshTree();
      const ids = [out.task_page?.id, out.note_page?.id].filter((x): x is number => x != null);
      reloadEditors(ids);
      const open = out.note_page ?? out.task_page;
      const what = out.note_page && out.task_page ? "Aufgabe und Notiz angelegt" : out.note_page ? "Notiz angelegt" : "Aufgabe angelegt";
      const where = out.task_page && out.task_page.id !== out.note_page?.id ? `Aufgabe in „${out.task_page.title}“` : undefined;
      s().toast({
        tone: "success",
        title: what,
        detail: [where, out.attachments.length ? `${out.attachments.length} ${out.attachments.length === 1 ? "Anhang" : "Anhänge"} gespeichert` : ""].filter(Boolean).join(" · ") || undefined,
        action: open ? { label: "Öffnen", run: () => s().openPage(open.id) } : undefined,
      });
      if (index + 1 < mails.length) useMailDialog.getState().set({ index: index + 1 });
      else onDone();
    } catch (e) {
      s().error("E-Mail nicht übernommen", e);
    } finally {
      setSaving(false);
    }
  };

  const toggle = (i: number) => setPicked((p) => {
    const n = new Set(p);
    if (n.has(i)) n.delete(i);
    else n.add(i);
    return n;
  });
  const valid = (!withTask || taskText.trim() !== "") && (!withNote || noteTitle.trim() !== "" || mail.subject.trim() !== "");
  const sourceLabel = { outlook: "Outlook", eml: ".eml", msg: ".msg", text: "Eingefügt" }[mail.source];

  return (
    <div className="mailx-form">
      <section className="mailx-card" aria-label="E-Mail">
        <div className="mailx-card-head">
          <div className="mailx-subject">{mail.subject || "(ohne Betreff)"}</div>
          <div className="mailx-badges">
            {mail.importance >= 2 && <Badge tone="warning">Wichtig</Badge>}
            <Badge>{sourceLabel}</Badge>
          </div>
        </div>
        <dl className="mailx-meta">
          <dt>Von</dt>
          <dd className="ellipsis" title={senderLabel(mail)}>{senderLabel(mail)}</dd>
          {mail.received && (
            <>
              <dt>Datum</dt>
              <dd>{dateTime(mail.received)}</dd>
            </>
          )}
          {mail.to.length > 0 && (
            <>
              <dt>An</dt>
              <dd className="ellipsis" title={mail.to.join("; ")}>{mail.to.join("; ")}</dd>
            </>
          )}
          {mail.cc.length > 0 && (
            <>
              <dt>Cc</dt>
              <dd className="ellipsis" title={mail.cc.join("; ")}>{mail.cc.join("; ")}</dd>
            </>
          )}
        </dl>
        {mail.body ? <div className="mailx-preview">{preview(mail.body)}</div> : <div className="mailx-preview faint">Kein Text</div>}
        {mails.length > 1 && (
          <div className="mailx-pager">
            <IconButton icon={ChevronLeft} label="Vorherige E-Mail" size="sm" disabled={index === 0} onClick={() => useMailDialog.getState().set({ index: index - 1 })} />
            <span className="faint">
              {index + 1} von {mails.length}
            </span>
            <IconButton icon={ChevronRight} label="Nächste E-Mail" size="sm" disabled={index + 1 >= mails.length} onClick={() => useMailDialog.getState().set({ index: index + 1 })} />
          </div>
        )}
      </section>

      <div className="mailx-fields">
        <Segmented<Action>
          label="Übernehmen als"
          value={action}
          onChange={setAction}
          options={[
            { value: "task", label: "Aufgabe" },
            { value: "note", label: "Notiz" },
            { value: "both", label: "Beides" },
          ]}
        />

        {withTask && (
          <fieldset className="mailx-group" aria-label="Aufgabe">
            <Field label="Aufgabe">
              <div className="mailx-inline">
                <Input value={taskText} onChange={(e) => setTaskText(e.target.value)} aria-label="Text der Aufgabe" data-autofocus className="mailx-task-text" />
                {mail.body.trim() !== "" && (
                  <Button
                    icon={Sparkles}
                    variant="ghost"
                    size="sm"
                    loading={suggesting}
                    disabled={!status?.local_ai}
                    title={status?.local_ai ? `Mit ${status.local_ai} – der Text verlässt diesen Computer nicht` : "Nur mit einem lokalen KI-Modell (Einstellungen → KI: Anbieter als „lokal“ markieren und für die Stufe „Lokal“ wählen)"}
                    onClick={() => void suggest()}
                  >
                    Aufgabe vorschlagen
                  </Button>
                )}
              </div>
            </Field>
            <Field label="Ziel">
              <Select value={target} onChange={(e) => setTarget(e.target.value)} options={targetOptions} aria-label="Ziel der Aufgabe" className="mailx-target" />
            </Field>
            <div className="mailx-row">
              <Field label="Fällig">
                <div className="mailx-due">
                  <div className="mailx-chips" role="group" aria-label="Schnellauswahl Fälligkeit">
                    {DUE_CHOICES.map((c) => {
                      const day = dueFor(c.id);
                      return (
                        <button key={c.id} type="button" className={`mailx-chip ${due === day ? "on" : ""}`} aria-pressed={due === day} title={dayLabel(day)} onClick={() => setDue(due === day ? "" : day)}>
                          {c.label}
                        </button>
                      );
                    })}
                  </div>
                  <DateInput value={due} onChange={setDue} aria-label="Fälligkeitsdatum" className="mailx-date" />
                  {due && <IconButton icon={X} label="Ohne Fälligkeit" size="sm" onClick={() => setDue("")} />}
                </div>
              </Field>
              <Field label="Priorität">
                <Segmented
                  label="Priorität"
                  value={priority}
                  onChange={setPriority}
                  options={[
                    { value: "0", label: "Normal" },
                    { value: "1", label: "Mittel" },
                    { value: "2", label: "Hoch" },
                  ]}
                />
              </Field>
            </div>
          </fieldset>
        )}

        {withNote && (
          <fieldset className="mailx-group" aria-label="Notiz">
            <div className="mailx-row">
              <Field label="Titel der Notiz">
                <Input value={noteTitle} onChange={(e) => setNoteTitle(e.target.value)} aria-label="Titel der Notiz" />
              </Field>
              <Field label="Unter Seite">
                <Input value={parent} onChange={(e) => setParent(e.target.value)} aria-label="Übergeordnete Seite" placeholder="E-Mails" />
              </Field>
            </div>
          </fieldset>
        )}

        {canAttach && mail.attachments.length > 0 && (
          <fieldset className="mailx-group" aria-label="Anhänge">
            <div className="mailx-group-head">
              <Paperclip size={14} aria-hidden /> Anhänge speichern
              {inlineCount > 0 && (
                <button type="button" className="mailx-link" onClick={() => setWithInline(!withInline)}>
                  {withInline ? "Eingebettete Bilder ausblenden" : `${inlineCount} eingebettete ${inlineCount === 1 ? "Bild" : "Bilder"} zeigen`}
                </button>
              )}
            </div>
            <ul className="mailx-files">
              {offered.map((a) => (
                <li key={a.index}>
                  <label>
                    <input type="checkbox" className="check" checked={picked.has(a.index)} onChange={() => toggle(a.index)} aria-label={`Anhang ${a.name} speichern`} />
                    <span className="ellipsis">{a.name}</span>
                    <span className="faint num">{a.size ? fileSize(a.size) : ""}</span>
                  </label>
                </li>
              ))}
            </ul>
            {!withNote && picked.size > 0 && <p className="faint mailx-small">Anhänge werden gespeichert; eingebettet werden sie nur in eine Notiz.</p>}
          </fieldset>
        )}

        <div className="mailx-row">
          <Field label="Vorgang (optional)" hint="Für die spätere Buchung, z. B. NP-8801/1020">
            <Input value={vorgang} onChange={(e) => setVorgang(e.target.value)} aria-label="Vorgang" placeholder="NP-…/…" className="mono" />
          </Field>
          {mail.categories.length > 0 && (
            <Field label="Outlook-Kategorien">
              <label className="mailx-check">
                <input type="checkbox" className="check" checked={useTags} onChange={() => setUseTags(!useTags)} />
                <span>Als Tags übernehmen: {mail.categories.join(", ")}</span>
              </label>
            </Field>
          )}
        </div>
      </div>

      <div className="mailx-foot">
        <span className="faint mailx-small">Der Text der E-Mail bleibt auf diesem Computer.</span>
        <div className="mailx-foot-actions">
          {mails.length > 1 && index + 1 < mails.length && (
            <Button variant="ghost" onClick={() => useMailDialog.getState().set({ index: index + 1 })}>
              Überspringen
            </Button>
          )}
          <Button variant="ghost" onClick={onDone}>
            Abbrechen
          </Button>
          <Button variant="primary" loading={saving} disabled={!valid || saving} onClick={() => void submit()} className="mailx-submit">
            {saving ? "Wird übernommen …" : "Übernehmen"}
          </Button>
        </div>
      </div>
    </div>
  );
}
