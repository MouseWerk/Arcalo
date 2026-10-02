// Settings → Datenschutz: where API keys, tokens and passwords are kept. On Linux the Secret
// Service (GNOME Keyring, KWallet); only without one a file readable by the user, said here.

import { useEffect, useState } from "react";
import { Badge } from "../../components/ui";
import { api } from "../../lib/api";
import { useT } from "../../lib/i18n";
import type { SecretStoreStatus } from "../../lib/types";
import { Group, Row } from "./common";

export function SecretStoreGroup() {
  const t = useT();
  const [status, setStatus] = useState<SecretStoreStatus | null>(null);
  useEffect(() => void api.secretsStatus().then(setStatus, () => setStatus(null)), []);
  if (!status) return null;
  const file = status.kind === "file";
  const moved = status.migration?.moved ?? 0;
  const description = file ? t("secrets.fileDesc") : status.portable ? t("secrets.portableDesc") : t("secrets.keyringDesc");
  return (
    <Group title={t("secrets.title")}>
      <Row
        stack
        label={t("secrets.store")}
        description={
          <span className="secret-store-desc">
            <span>{description}</span>
            {file && status.reason && <span className="faint small secret-store-reason selectable">{t("secrets.reason", { reason: status.reason })}</span>}
            {moved > 0 && <span className="small">{t("secrets.moved", { n: moved })}</span>}
            {status.file_left && <span className="small mirror-error">{t("secrets.fileLeft")}</span>}
          </span>
        }
      >
        <div className={`secret-store secret-store-${status.kind}`} data-kind={status.kind}>
          <span className="secret-store-label">{status.label}</span>
          <Badge tone={file ? "warning" : "success"}>{file ? t("secrets.fallback") : t("secrets.secure")}</Badge>
        </div>
      </Row>
    </Group>
  );
}
