// Settings → Tastatur: rebind the in-app shortcuts, with conflict detection and reset.
// Global shortcuts (palette, quick capture) stay under Desktop.

import { useState } from "react";
import { RotateCcw, X } from "lucide-react";
import { Badge, Button, IconButton } from "../../components/ui";
import { useT } from "../../lib/i18n";
import { COMMANDS, DEFAULT_KEYMAP, comboFromEvent, comboLabel, comboProblem, effectiveKeymap, findConflicts, keymapOverrides } from "../../lib/keymap";
import { Group, Row, SectionHead, type SectionProps } from "./common";

export function KeyboardSection({ draft, update }: SectionProps) {
  const t = useT();
  const map = effectiveKeymap(draft.keymap);
  const [recording, setRecording] = useState<string | null>(null);
  const [problem, setProblem] = useState<{ id: string; text: string } | null>(null);
  const conflicts = findConflicts(map, { capture: draft.capture_shortcut, palette: draft.palette_shortcut, selection: draft.capture?.selection_shortcut, mail: draft.mail?.shortcut });
  const conflictOf = (id: string) => conflicts.filter((c) => c.commands.includes(id));
  const setCombo = (id: string, combo: string) => update({ keymap: keymapOverrides({ ...map, [id]: combo }) });
  const otherLabel = (other: NonNullable<(typeof conflicts)[number]["other"]>) =>
    other === "global.capture"
      ? t("keys.globalCapture")
      : other === "global.palette"
        ? t("keys.globalPalette")
        : other === "global.selection"
          ? t("keys.globalSelection")
          : other === "global.mail"
            ? t("keys.globalMail")
            : t(other);

  return (
    <>
      <SectionHead title={t("set.keys.title")} intro={t("set.keys.intro")} />
      <Group title={t("set.keys.commands")} description={t("set.keys.commandsDesc")}>
        {COMMANDS.map((c) => {
          const combo = map[c.id];
          const own = conflictOf(c.id);
          const changed = combo !== DEFAULT_KEYMAP[c.id];
          return (
            <Row
              key={c.id}
              label={t(c.label)}
              keywords={`${c.id} ${comboLabel(combo)}`}
              description={
                own.length > 0 || problem?.id === c.id ? (
                  <span className="mirror-error keys-conflict">
                    {problem?.id === c.id
                      ? problem.text
                      : own
                          .map((x) =>
                            x.other
                              ? t("keys.conflictWith", { what: otherLabel(x.other) })
                              : t("keys.conflictWith", { what: x.commands.filter((i) => i !== c.id).map((i) => t(COMMANDS.find((k) => k.id === i)!.label)).join(", ") }),
                          )
                          .join(" · ")}
                  </span>
                ) : undefined
              }
            >
              <div className="unit-input shortcut-input">
                <button
                  type="button"
                  className={`key-recorder ${recording === c.id ? "recording" : ""}`}
                  data-command={c.id}
                  aria-label={t("keys.record", { command: t(c.label) })}
                  onClick={() => {
                    setProblem(null);
                    setRecording(c.id);
                  }}
                  onBlur={() => recording === c.id && setRecording(null)}
                  onKeyDown={(e) => {
                    if (recording !== c.id) return;
                    e.preventDefault();
                    e.stopPropagation();
                    if (e.key === "Escape") return setRecording(null);
                    if (!e.ctrlKey && !e.altKey && !e.metaKey && (e.key === "Backspace" || e.key === "Delete")) {
                      setCombo(c.id, "");
                      return setRecording(null);
                    }
                    const native = e.nativeEvent;
                    if ((native.ctrlKey || native.metaKey) && native.altKey) {
                      setProblem({ id: c.id, text: t("keys.problem.altgr") });
                      return setRecording(null);
                    }
                    const next = comboFromEvent(native);
                    if (!next) return;
                    const bad = comboProblem(next);
                    if (bad) {
                      setProblem({ id: c.id, text: t(bad) });
                      return setRecording(null);
                    }
                    setCombo(c.id, next);
                    setRecording(null);
                  }}
                >
                  {recording === c.id ? (
                    <span className="faint">{t("keys.press")}</span>
                  ) : combo ? (
                    comboLabel(combo)
                      .split(" ")
                      .map((k, i) => <kbd key={i}>{k}</kbd>)
                  ) : (
                    <span className="faint">{t("keys.none")}</span>
                  )}
                </button>
                {changed && <Badge tone="accent">{t("keys.custom")}</Badge>}
                {combo && <IconButton icon={X} label={t("keys.clear")} size="sm" onClick={() => setCombo(c.id, "")} />}
                {changed && <IconButton icon={RotateCcw} label={t("keys.resetOne")} size="sm" onClick={() => setCombo(c.id, DEFAULT_KEYMAP[c.id])} />}
              </div>
            </Row>
          );
        })}
      </Group>
      <Group title={t("set.keys.reset")}>
        <Row label={t("set.keys.resetAll")} description={t("set.keys.resetAllDesc")}>
          <Button icon={RotateCcw} disabled={Object.keys(draft.keymap ?? {}).length === 0} onClick={() => update({ keymap: {} })}>
            {t("common.reset")}
          </Button>
        </Row>
      </Group>
    </>
  );
}
