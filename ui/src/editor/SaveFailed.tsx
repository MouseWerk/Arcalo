// The note above an editor whose last save failed (full disk, read-only folder): the edits stay
// in the editor and are saved again shortly. Same in the visual editor and the source view.

import { AlertTriangle } from "lucide-react";
import { useT } from "../lib/i18n";

export function SaveFailed() {
  const tr = useT();
  return (
    <div className="save-failed" role="status">
      <span className="save-failed-pill">
        <AlertTriangle size={13} aria-hidden />
        {tr("ne.saveRetry")}
      </span>
    </div>
  );
}
