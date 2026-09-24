// Settings → KI (below server and models): answers, tools, costs, inline AI presets and the
// meeting summary template.

import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Plus, RotateCcw, Trash2 } from "lucide-react";
import { Button, IconButton, Input, Switch, TextArea } from "../../components/ui";
import { api } from "../../lib/api";
import { AI_PRESETS, meetingSummaryInstruction } from "../../lib/aitext";
import { useT, type TKey } from "../../lib/i18n";
import { usd } from "../../lib/format";
import type { AiPrefs, AiPresetDef, CostStatus } from "../../lib/types";
import { Group, NumberInput, Row, Unfiltered, type SectionProps } from "./common";

/** Tools the assistant can be offered, workspace tools first. */
export const TOOL_OPTIONS: { name: string; label: TKey; system: boolean }[] = [
  { name: "log_time", label: "tool.log_time", system: false },
  { name: "search_workspace", label: "tool.search_workspace", system: false },
  { name: "budget_status", label: "tool.budget_status", system: false },
  { name: "list_tasks", label: "tool.list_tasks", system: false },
  { name: "time_summary", label: "tool.time_summary", system: false },
  { name: "activity_log", label: "tool.activity_log", system: false },
  { name: "run_powershell", label: "tool.run_powershell", system: true },
  { name: "git", label: "tool.git", system: true },
  { name: "http_request", label: "tool.http_request", system: true },
];

export function AiPrefGroups({ draft, update }: SectionProps) {
  const t = useT();
  const ai = draft.ai;
  const set = (p: Partial<AiPrefs>) => update({ ai: { ...ai, ...p } });
  const [cost, setCost] = useState<CostStatus | null>(null);
  useEffect(() => {
    api.costStatus().then(setCost, () => setCost(null));
  }, [ai.monthly_cost_limit_usd]);
  const presets: AiPresetDef[] = ai.inline_presets ?? AI_PRESETS.map((p) => ({ label: p.label, instruction: p.instruction }));
  const setPresets = (next: AiPresetDef[]) => set({ inline_presets: next });
  const movePreset = (i: number, d: number) => {
    const next = [...presets];
    const [x] = next.splice(i, 1);
    next.splice(i + d, 0, x);
    setPresets(next);
  };
  const toggleTool = (name: string, on: boolean) =>
    set({ allowed_tools: on ? [...new Set([...ai.allowed_tools, name])] : ai.allowed_tools.filter((x) => x !== name) });

  return (
    <>
      <Group title={t("set.ai.answers")}>
        <Row label={t("set.ai.temperature")} description={t("set.ai.temperatureDesc")}>
          <NumberInput min={0} max={2} step={0.1} value={ai.temperature} onCommit={(v) => set({ temperature: v })} aria-label={t("set.ai.temperature")} />
        </Row>
        <Row label={t("set.ai.maxTokens")} description={t("set.ai.maxTokensDesc")}>
          <div className="unit-input">
            {ai.max_tokens != null && <NumberInput min={16} max={200000} value={ai.max_tokens} onCommit={(v) => set({ max_tokens: v })} aria-label={t("set.ai.maxTokens")} />}
            <span className="faint">{ai.max_tokens == null ? t("set.ai.unlimited") : t("unit.tokens")}</span>
            <Switch label={t("set.ai.maxTokensLimit")} checked={ai.max_tokens != null} onChange={(v) => set({ max_tokens: v ? 2000 : null })} />
          </div>
        </Row>
        <Row label={t("set.ai.streaming")} description={t("set.ai.streamingDesc")}>
          <Switch label={t("set.ai.streaming")} checked={ai.streaming} onChange={(v) => set({ streaming: v })} />
        </Row>
        <Row label={t("set.ai.citations")} description={t("set.ai.citationsDesc")}>
          <Switch label={t("set.ai.citations")} checked={ai.citations} onChange={(v) => set({ citations: v })} />
        </Row>
      </Group>

      <Group title={t("set.ai.tools")} description={t("set.ai.toolsDesc")}>
        {TOOL_OPTIONS.map((o) => (
          <Row key={o.name} label={t(o.label)} description={o.system ? t("set.ai.systemTool") : undefined} keywords={o.name}>
            <Switch label={t(o.label)} checked={ai.allowed_tools.includes(o.name)} onChange={(v) => toggleTool(o.name, v)} />
          </Row>
        ))}
      </Group>

      <Group title={t("set.ai.costs")}>
        <Row
          label={t("set.ai.costLimit")}
          description={
            <>
              <span>{t("set.ai.costLimitDesc")}</span>
              {cost && (
                <span className={cost.level === "blocked" ? "mirror-error" : cost.level === "warning" ? "warn-note" : ""}>
                  {t("set.ai.spent", { spent: usd(cost.spent_usd) })}
                </span>
              )}
            </>
          }
        >
          <div className="unit-input">
            {ai.monthly_cost_limit_usd != null && (
              <>
                <NumberInput min={0.5} max={100000} step={0.5} value={ai.monthly_cost_limit_usd} onCommit={(v) => set({ monthly_cost_limit_usd: v })} aria-label={t("set.ai.costLimit")} />
                <span className="faint">USD</span>
              </>
            )}
            <Switch label={t("set.ai.costLimit")} checked={ai.monthly_cost_limit_usd != null} onChange={(v) => set({ monthly_cost_limit_usd: v ? 20 : null })} />
          </div>
        </Row>
      </Group>

      <Group title={t("set.ai.presets")} description={t("set.ai.presetsDesc")}>
        <Row label={t("set.ai.presetsReset")} keywords="inline ki ctrl j">
          <Button icon={RotateCcw} variant="ghost" disabled={ai.inline_presets == null} onClick={() => set({ inline_presets: null })}>
            {t("common.reset")}
          </Button>
        </Row>
        <Unfiltered>
          <div className="preset-list">
            {presets.map((p, i) => (
              <div key={i} className="preset-row">
                <Input
                  value={p.label}
                  onChange={(e) => setPresets(presets.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
                  aria-label={t("set.ai.presetLabel", { n: i + 1 })}
                  className="preset-label"
                />
                <TextArea
                  rows={2}
                  autoGrow
                  value={p.instruction}
                  onChange={(e) => setPresets(presets.map((x, j) => (j === i ? { ...x, instruction: e.target.value } : x)))}
                  aria-label={t("set.ai.presetInstruction", { n: i + 1 })}
                />
                <div className="preset-actions">
                  <IconButton icon={ArrowUp} label={t("common.up")} size="sm" disabled={i === 0} onClick={() => movePreset(i, -1)} />
                  <IconButton icon={ArrowDown} label={t("common.down")} size="sm" disabled={i === presets.length - 1} onClick={() => movePreset(i, 1)} />
                  <IconButton icon={Trash2} label={t("common.remove")} size="sm" onClick={() => setPresets(presets.filter((_, j) => j !== i))} />
                </div>
              </div>
            ))}
            <Button icon={Plus} onClick={() => setPresets([...presets, { label: t("set.ai.newPreset"), instruction: "" }])}>
              {t("set.ai.addPreset")}
            </Button>
          </div>
        </Unfiltered>
      </Group>

      <Group title={t("set.ai.meeting")} description={t("set.ai.meetingDesc")}>
        <Row label={t("set.ai.meetingReset")} keywords="besprechung zusammenfassung vorlage meeting">
          <Button icon={RotateCcw} variant="ghost" disabled={ai.meeting_template == null} onClick={() => set({ meeting_template: null })}>
            {t("common.reset")}
          </Button>
        </Row>
        <Unfiltered>
          <TextArea
            rows={12}
            autoGrow
            className="mono small"
            value={ai.meeting_template ?? meetingSummaryInstruction()}
            onChange={(e) => set({ meeting_template: e.target.value })}
            aria-label={t("set.ai.meeting")}
          />
        </Unfiltered>
      </Group>
    </>
  );
}
