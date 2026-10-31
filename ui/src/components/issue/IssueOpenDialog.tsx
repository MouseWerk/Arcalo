// „Issue öffnen…“ (command palette): a key typed or pasted (also a Jira address), or one of the
// cached issues found by key or summary, opens in the issue view.

import { useMemo, useState } from "react";
import { Dialog, Button } from "../ui";
import { t } from "../../lib/i18n";
import { isComposing, isKey } from "../../lib/ime";
import { useIssueIndex, type ChipIssue } from "../../lib/jira";
import { openIssueView, parseIssueKey, useIssuePrompt } from "../../lib/issueFull";
import { TypeGlyph } from "./IssueModal";

export function IssueOpenDialog() {
  const open = useIssuePrompt((st) => st.open);
  const set = useIssuePrompt((st) => st.set);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const byKey = useIssueIndex((st) => st.byKey);
  const key = parseIssueKey(q);
  const found = useMemo<ChipIssue[]>(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const out: ChipIssue[] = [];
    for (const i of byKey.values()) {
      const hay = `${i.key} ${i.summary}`.toLowerCase();
      if (words.every((w) => hay.includes(w))) out.push(i);
      if (out.length >= 8) break;
    }
    return out;
  }, [q, byKey]);
  const choices: string[] = [...(key && !found.some((f) => f.key === key) ? [key] : []), ...found.map((f) => f.key)];
  const close = () => {
    set(false);
    setQ("");
    setSel(0);
  };
  const go = (k: string | undefined) => {
    if (!k) return;
    close();
    openIssueView(k);
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      title={t("iv.openTitle")}
      description={t("iv.openDesc")}
      width={480}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" disabled={!choices.length} onClick={() => go(choices[sel] ?? choices[0])}>
            {t("iv.openButton")}
          </Button>
        </>
      }
    >
      <input
        className="input iv-open-input"
        data-autofocus
        value={q}
        placeholder={t("iv.openPh")}
        aria-label={t("iv.openTitle")}
        role="combobox"
        aria-expanded={choices.length > 0}
        aria-controls="iv-open-list"
        aria-autocomplete="list"
        onChange={(e) => (setQ(e.target.value), setSel(0))}
        onKeyDown={(e) => {
          if (isComposing(e)) return;
          if (e.key === "ArrowDown") (e.preventDefault(), setSel((v) => Math.min(v + 1, choices.length - 1)));
          else if (e.key === "ArrowUp") (e.preventDefault(), setSel((v) => Math.max(v - 1, 0)));
          else if (isKey(e, "Enter")) (e.preventDefault(), go(choices[sel] ?? choices[0]));
        }}
      />
      <ul id="iv-open-list" className="iv-open-list" role="listbox" aria-label={t("iv.openTitle")}>
        {choices.map((k, i) => {
          const issue = byKey.get(k);
          return (
            <li key={k} role="option" aria-selected={i === sel}>
              <button type="button" className={`iv-picker-item ${i === sel ? "sel" : ""}`} onMouseEnter={() => setSel(i)} onClick={() => go(k)}>
                {issue && <TypeGlyph name={issue.issue_type} />}
                <span className="mono">{k}</span>
                <span className="ellipsis faint">{issue?.summary ?? t("iv.openView")}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </Dialog>
  );
}
