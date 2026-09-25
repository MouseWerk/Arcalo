// Settings → Kalender → „E-Mail (Outlook)“: where mail notes go, the global shortcut of
// „Aktuelle E-Mail übernehmen“ (off by default, checked like the other global shortcuts),
// whether attachments start ticked and whether mail notes are marked confidential.

import { useEffect, useState } from "react";
import { Mail } from "lucide-react";
import { api } from "../../lib/api";
import { useApp } from "../../store/app";
import { Button, Segmented, Switch } from "../../components/ui";
import { openMailDialog } from "../../components/MailImport";
import { mailApi } from "../../lib/mail";
import type { DesktopInfo, MailSettings } from "../../lib/types";
import { CommitInput, Group, Row, ShortcutField, type SectionProps } from "./common";

const DEFAULTS: MailSettings = { notes_parent: "E-Mails", shortcut: "", save_attachments: false, private_notes: true, default_action: "task" };

export function MailGroup({ draft, update }: SectionProps) {
  const mail = { ...DEFAULTS, ...draft.mail };
  const saved = useApp((s) => s.settings?.settings.mail);
  const [info, setInfo] = useState<DesktopInfo | null>(null);
  const [outlook, setOutlook] = useState(false);
  useEffect(() => void mailApi.status().then((st) => setOutlook(st.outlook_available), () => setOutlook(false)), []);
  useEffect(() => void api.desktopInfo().then(setInfo, () => setInfo(null)), [saved?.shortcut]);
  const set = (p: Partial<MailSettings>) => update({ mail: { ...mail, ...p } });
  const marker = draft.router?.private_markers?.[0] ?? "#vertraulich";
  return (
    <Group
      title="E-Mail (Outlook)"
      description="Eine E-Mail als Aufgabe oder Notiz übernehmen, mit einem Link zurück zur E-Mail. Aus Outlook (klassisch), aus .eml- und .msg-Dateien, die ins Fenster gezogen werden, oder aus eingefügten Kopfzeilen."
    >
      {outlook && (
        <Row label="Tastenkürzel (global)" description="Übernimmt die in Outlook markierte oder geöffnete E-Mail, auch wenn Annalo im Hintergrund ist. Ins Feld klicken und die Tasten drücken, z. B. Ctrl+Shift+M. Entf = aus.">
          <ShortcutField
            value={mail.shortcut}
            onChange={(v) => set({ shortcut: v })}
            label="Tastenkürzel E-Mail übernehmen"
            placeholder="Aus"
            active={info ? mail.shortcut === (saved?.shortcut ?? "") && !!info.mail_shortcut_active : undefined}
          />
        </Row>
      )}
      <Row label="Notizen ablegen unter" description="Neue E-Mail-Notizen entstehen als Unterseiten dieser Seite (sie wird bei Bedarf angelegt).">
        <CommitInput value={mail.notes_parent} onCommit={(v) => set({ notes_parent: v.trim() || "E-Mails" })} aria-label="Seite für E-Mail-Notizen" />
      </Row>
      <Row label="Zuerst anbieten">
        <Segmented
          label="Zuerst anbieten"
          value={mail.default_action}
          onChange={(v) => set({ default_action: v })}
          options={[
            { value: "task", label: "Aufgabe" },
            { value: "note", label: "Notiz" },
            { value: "both", label: "Beides" },
          ]}
        />
      </Row>
      <Row label="Anhänge vorauswählen" description="Anhänge sind im Dialog schon angehakt (eingebettete Bilder wie Logos nie).">
        <Switch label="Anhänge vorauswählen" checked={mail.save_attachments} onChange={(v) => set({ save_attachments: v })} />
      </Row>
      <Row label="E-Mail-Notizen vertraulich" description={`Notizen aus E-Mails bekommen den Tag ${marker}: der KI-Assistent verarbeitet sie dann nur mit dem lokalen Modell. E-Mails gehen nie von selbst an eine KI.`}>
        <Switch label="E-Mail-Notizen vertraulich" checked={mail.private_notes} onChange={(v) => set({ private_notes: v })} />
      </Row>
      <Row label="E-Mail übernehmen" description="Öffnet den Dialog (auch über die Befehlspalette).">
        <Button icon={Mail} onClick={() => openMailDialog()}>
          E-Mail übernehmen…
        </Button>
      </Row>
    </Group>
  );
}
