// Settings → Zeiterfassung → „Saldo und Urlaub“: target hours per weekday, start and opening
// balance of the overtime balance, vacation days and the state for public holidays.

import { Select, Switch } from "../../components/ui";
import { DateInput } from "../../components/DateInput";
import { useT, type TKey } from "../../lib/i18n";
import { weekdayLabels } from "../../lib/format";
import type { BalancePrefs } from "../../lib/types";
import { Group, NumberInput, Row, type SectionProps } from "./common";

export const STATES = ["BW", "BY", "BE", "BB", "HB", "HH", "HE", "MV", "NI", "NW", "RP", "SL", "SN", "ST", "SH", "TH"] as const;

export const DEFAULT_BALANCE: BalancePrefs = { weekday_hours: [], start: null, opening_hours: 0, vacation_days: 30, carry_over: 0, state: "" };

/** The targets Monday..Sunday the settings imply: their own, else the daily target on the workdays. */
export function weekdayTargets(b: BalancePrefs, daily: number, workdays: number[]): number[] {
  return b.weekday_hours.length === 7 ? b.weekday_hours : [1, 2, 3, 4, 5, 6, 7].map((d) => (workdays.includes(d) ? daily : 0));
}

export function BalancePrefGroup({ draft, update }: SectionProps) {
  const t = useT();
  const b: BalancePrefs = { ...DEFAULT_BALANCE, ...(draft.time.balance ?? {}) };
  const set = (p: Partial<BalancePrefs>) => update({ time: { ...draft.time, balance: { ...b, ...p } } });
  const own = b.weekday_hours.length === 7;
  const targets = weekdayTargets(b, draft.daily_target_hours, draft.workdays);
  const labels = weekdayLabels(1);
  return (
    <Group title={t("work.bp.title")} description={t("work.bp.desc")}>
      <Row label={t("work.bp.ownTargets")} description={t("work.bp.ownTargetsDesc")}>
        <Switch label={t("work.bp.ownTargets")} checked={own} onChange={(v) => set({ weekday_hours: v ? targets : [] })} />
      </Row>
      {own && (
        <Row label={t("work.bp.targets")} stack>
          <div className="bp-week">
            {labels.map((l, i) => (
              <label key={l} className="bp-day">
                <span className="faint small">{l}</span>
                <NumberInput min={0} max={24} step={0.25} value={targets[i]} onCommit={(v) => set({ weekday_hours: targets.map((x, j) => (j === i ? v : x)) })} aria-label={t("work.bp.targetOf", { day: l })} />
              </label>
            ))}
          </div>
        </Row>
      )}
      <Row label={t("work.bp.start")} description={t("work.bp.startDesc")}>
        <DateInput value={b.start ?? ""} onChange={(v) => set({ start: v || null })} aria-label={t("work.bp.start")} placeholder={t("work.bp.startPh")} />
      </Row>
      <Row label={t("work.bp.opening")} description={t("work.bp.openingDesc")}>
        <div className="unit-input">
          <NumberInput min={-10000} max={10000} step={0.25} value={b.opening_hours} onCommit={(v) => set({ opening_hours: v })} aria-label={t("work.bp.opening")} />
          <span className="faint">h</span>
        </div>
      </Row>
      <Row label={t("work.bp.vacation")}>
        <div className="unit-input">
          <NumberInput min={0} max={366} step={0.5} value={b.vacation_days} onCommit={(v) => set({ vacation_days: v })} aria-label={t("work.bp.vacation")} />
          <span className="faint">{t("unit.days")}</span>
        </div>
      </Row>
      <Row label={t("work.bp.carry")} description={t("work.bp.carryDesc")}>
        <div className="unit-input">
          <NumberInput min={0} max={366} step={0.5} value={b.carry_over} onCommit={(v) => set({ carry_over: v })} aria-label={t("work.bp.carry")} />
          <span className="faint">{t("unit.days")}</span>
        </div>
      </Row>
      <Row label={t("work.bp.state")} description={t("work.bp.stateDesc")}>
        <Select
          aria-label={t("work.bp.state")}
          value={b.state}
          onChange={(e) => set({ state: e.target.value })}
          options={[{ value: "", label: t("work.bp.noState") }, ...STATES.map((s) => ({ value: s, label: `${t(`work.state.${s}` as TKey)} (${s})` }))]}
        />
      </Row>
    </Group>
  );
}
