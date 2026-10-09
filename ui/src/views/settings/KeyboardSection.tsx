// Settings → Tastatur: rebind the in-app shortcuts, with conflict detection and reset.
// Global shortcuts (palette, quick capture) stay under Desktop.

import { Fragment, useState } from "react";
import { RotateCcw, X } from "lucide-react";
import { Badge, Button, IconButton } from "../../components/ui";
import { useT } from "../../lib/i18n";
import { COMMANDS, DEFAULT_KEYMAP, comboFromEvent, comboLabel, comboProblem, effectiveKeymap, findConflicts, imeNote, keymapOverrides } from "../../lib/keymap";
import { KEY_HELP, helpSpec } from "../../lib/keyhelp";
import { keyChips, keys } from "../../lib/shortcut";
import { AI_SHORTCUTS, aiSwitchOn } from "../../lib/aiswitch";
import { useApp } from "../../store/app";
import { Group, Row, SectionHead, type SectionProps } from "./common";
import { TIME_SHORTCUTS, timeTrackingOn } from "../../lib/timetracking";
import { isComposing } from "../../lib/ime";

export function KeyboardSection({ draft, update }: SectionProps) {
  const t = useT();
  const map = effectiveKeymap(draft.keymap);
  const [recording, setRecording] = useState<string | null>(null);
  // „KI verwenden“ off (or off by policy): no assistant and chat shortcuts.
  const policyOff = useApp((s) => !!s.settings?.ai_policy_off);
  const ai = aiSwitchOn(draft) && !policyOff;
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
      <SectionHead title={t("set.keys.title")} intro={t("set.keys.intro")} help="shortcuts" />
      <Group title={t("set.keys.commands")} description={t("set.keys.commandsDesc")}>
        {/* Time tracking or AI off: the timer, assistant and chat shortcuts are not listed (they do nothing then). */}
        {COMMANDS.filter((c) => (timeTrackingOn(draft) || !TIME_SHORTCUTS.has(c.id)) && (ai || !AI_SHORTCUTS.has(c.id))).map((c) => {
          const combo = map[c.id];
          const own = conflictOf(c.id);
          const changed = combo !== DEFAULT_KEYMAP[c.id];
          const note = imeNote(combo);
          return (
            <Row
              key={c.id}
              label={t(c.label)}
              keywords={`${c.id} ${comboLabel(combo)}`}
              description={
                own.length === 0 && problem?.id !== c.id && note ? (
                  <span className="faint">{t(note)}</span>
                ) : own.length > 0 || problem?.id === c.id ? (
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
                  // The name says the current combination too (the kbd content is replaced by it).
                  aria-label={recording === c.id ? t("keys.record", { command: t(c.label) }) : t("keys.recordValue", { command: t(c.label), keys: combo ? comboLabel(combo) : t("keys.none") })}
                  onClick={() => {
                    setProblem(null);
                    setRecording(c.id);
                  }}
                  onBlur={() => recording === c.id && setRecording(null)}
                  onKeyDown={(e) => {
                    if (isComposing(e)) return;
                    if (recording !== c.id) return;
                    // Tab leaves the recorder as anywhere else (no command is bound to it).
                    if (e.key === "Tab" && !e.ctrlKey && !e.altKey && !e.metaKey) return setRecording(null);
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
                    <span className="faint" aria-live="polite">
                      {t("keys.press")}
                    </span>
                  ) : combo ? (
                    keyChips(comboLabel(combo)).map((k, i) => <kbd key={i}>{k}</kbd>)
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
      {/* The fixed keys of the views (help → „Tastenkürzel“ lands here): one table, read-only. */}
      {KEY_HELP.map((g, gi) => (
        <Group key={g.title} title={t(g.title)} description={gi === 0 ? t("kh.desc") : undefined}>
          {g.items
            .filter((it) => (ai || it.label !== "kh.palAsk") && (timeTrackingOn(draft) || it.label !== "kh.palTime"))
            .map((it) => (
              <Row key={it.label} label={t(it.label)} keywords={`${t("kh.title")} ${it.keys.join(" ")}`}>
                <span className="keys key-help">
                  {it.keys.map((spec, i) => (
                    <Fragment key={spec}>
                      {i > 0 && <span className="faint key-help-or">{t("kh.or")}</span>}
                      {it.typed ? (
                        <code>{spec}</code>
                      ) : (
                        keyChips(helpSpec(spec) ?? keys(spec)).map((k, j) => <kbd key={j}>{k}</kbd>)
                      )}
                    </Fragment>
                  ))}
                </span>
              </Row>
            ))}
        </Group>
      ))}
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
