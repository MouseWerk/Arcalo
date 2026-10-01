// Settings → Datenschutz → Chat-Verlauf: how long the assistant's chats are kept, and
// „Alle Chats löschen“.

import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { Button, Select } from "../../components/ui";
import { api } from "../../lib/api";
import { useT } from "../../lib/i18n";
import type { ChatRetention } from "../../lib/types";
import { useApp } from "../../store/app";
import { deleteAllChats, useChat } from "../../store/chat";
import { Group, Row, type SectionProps } from "./common";

export function ChatHistoryGroup({ draft, update }: SectionProps) {
  const t = useT();
  const ai = draft.ai;
  const listVersion = useChat((s) => s.listVersion);
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    api
      .chatList("", true)
      .then((l) => setCount(l.length))
      .catch(() => setCount(null));
  }, [listVersion]);
  const clearAll = async () => {
    const s = useApp.getState();
    const ok = await s.confirm({ title: t("chat.set.deleteAllTitle"), message: t("chat.set.deleteAllMessage"), confirmLabel: t("chat.set.deleteAll"), danger: true });
    if (!ok) return;
    try {
      const n = await deleteAllChats();
      s.toast({ tone: "success", title: t("chat.set.deletedAll", { n }) });
    } catch (e) {
      s.error(t("chat.set.deleteAllFailed"), e);
    }
  };
  return (
    <Group title={t("chat.set.group")} description={t("chat.set.groupDesc")}>
      <Row label={t("chat.set.retention")} description={t("chat.set.retentionDesc")}>
        <Select value={ai.chat_history ?? "all"} onChange={(e) => update({ ai: { ...ai, chat_history: e.target.value as ChatRetention } })} aria-label={t("chat.set.retention")}>
          <option value="all">{t("chat.set.keepAll")}</option>
          <option value="90">{t("chat.set.keep90")}</option>
          <option value="30">{t("chat.set.keep30")}</option>
          <option value="off">{t("chat.set.keepOff")}</option>
        </Select>
      </Row>
      <Row label={t("chat.set.deleteAll")} description={count == null ? t("chat.set.deleteAllDesc") : t("chat.set.count", { n: count })}>
        <Button variant="danger" icon={Trash2} disabled={count === 0} onClick={clearAll}>
          {t("chat.set.deleteAllButton")}
        </Button>
      </Row>
    </Group>
  );
}
