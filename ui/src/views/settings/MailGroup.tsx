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
import { t, useT } from "../../lib/i18n";

const defaults = (): MailSettings => ({ notes_parent: t("mail.parentDefault"), shortcut: "", save_attachments: false, private_notes: true, default_action: "task" });

export function MailGroup({ draft, update }: SectionProps) {
  const t = useT();
  const mail = { ...defaults(), ...draft.mail };
  const saved = useApp((s) => s.settings?.settings.mail);
  const [info, setInfo] = useState<DesktopInfo | null>(null);
  const [outlook, setOutlook] = useState(false);
  useEffect(() => void mailApi.status().then((st) => setOutlook(st.outlook_available), () => setOutlook(false)), []);
  useEffect(() => void api.desktopInfo().then(setInfo, () => setInfo(null)), [saved?.shortcut]);
  const set = (p: Partial<MailSettings>) => update({ mail: { ...mail, ...p } });
  const marker = draft.router?.private_markers?.[0] ?? "#vertraulich";
  return (
    <Group title={t("mailset.title")} description={t("mailset.desc")}>
      {outlook && (
        <Row label={t("set.desktop.globalShortcut")} description={t("mailset.shortcutDesc")}>
          <ShortcutField
            value={mail.shortcut}
            onChange={(v) => set({ shortcut: v })}
            label={t("mailset.shortcut")}
            placeholder={t("common.off")}
            active={info ? mail.shortcut === (saved?.shortcut ?? "") && !!info.mail_shortcut_active : undefined}
          />
        </Row>
      )}
      <Row label={t("mailset.parent")} description={t("mailset.parentDesc")}>
        <CommitInput value={mail.notes_parent} onCommit={(v) => set({ notes_parent: v.trim() || t("mail.parentDefault") })} aria-label={t("mailset.parentLabel")} />
      </Row>
      <Row label={t("mailset.first")}>
        <Segmented
          label={t("mailset.first")}
          value={mail.default_action}
          onChange={(v) => set({ default_action: v })}
          options={[
            { value: "task", label: t("err.kind.task") },
            { value: "note", label: t("mail.note") },
            { value: "both", label: t("mail.both") },
          ]}
        />
      </Row>
      <Row label={t("mailset.preselect")} description={t("mailset.preselectDesc")}>
        <Switch label={t("mailset.preselect")} checked={mail.save_attachments} onChange={(v) => set({ save_attachments: v })} />
      </Row>
      <Row label={t("mailset.private")} description={t("mailset.privateDesc", { marker })}>
        <Switch label={t("mailset.private")} checked={mail.private_notes} onChange={(v) => set({ private_notes: v })} />
      </Row>
      <Row label={t("mail.title")} description={t("mailset.dialogDesc")}>
        <Button icon={Mail} onClick={() => openMailDialog()}>
          {t("cmd.mailDialog")}
        </Button>
      </Row>
    </Group>
  );
}
