// Date and time fields in the app's format, whatever the system locale: the native pickers
// follow the OS (10/01/2026, 9:30 AM), these always show 01.10.2026 and 09:30.

import { useEffect, useState, type InputHTMLAttributes } from "react";
import { CalendarDays } from "lucide-react";
import { fmtDate, parseDayInput, parseTimeInput } from "../lib/format";
import { pickDate } from "./CalendarPopover";
import { IconButton } from "./ui";

type Rest = Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type">;

/** A day (YYYY-MM-DD) shown in the configured date format, for display only. */
export const dayLabel = (iso: string) => (iso ? fmtDate(new Date(`${iso}T12:00:00`)) : "");

/** Typed („1.10.“, „01.10.2026“, „2026-10-01“) or picked in the calendar (button, Alt+↓). */
export function DateInput({ value, onChange, className = "", ...rest }: Rest & { value: string; onChange: (iso: string) => void }) {
  const [text, setText] = useState(dayLabel(value));
  const [editing, setEditing] = useState(false);
  // While typing, a valid prefix („1.10.“) must not be rewritten under the caret.
  useEffect(() => {
    if (!editing) setText(dayLabel(value));
  }, [value, editing]);
  const parsed = parseDayInput(text);
  const invalid = text.trim() !== "" && !parsed;
  const pick = (el: Element) => pickDate(el, value, onChange);
  return (
    <span className={`input affix-input ${className}`} data-invalid={invalid || undefined}>
      <input
        {...rest}
        value={text}
        placeholder="TT.MM.JJJJ"
        spellCheck={false}
        aria-invalid={invalid || undefined}
        onChange={(e) => {
          setText(e.target.value);
          const iso = parseDayInput(e.target.value);
          if (iso && iso !== value) onChange(iso);
        }}
        onFocus={() => setEditing(true)}
        onBlur={() => setEditing(false)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && e.altKey) {
            e.preventDefault();
            pick(e.currentTarget.parentElement!);
          }
        }}
      />
      <IconButton icon={CalendarDays} label="Kalender" size="sm" tabIndex={-1} onClick={(e) => pick(e.currentTarget.parentElement!)} />
    </span>
  );
}

/** A time of day as 24-hour HH:MM; „930“ or „9.30“ are read as 09:30. */
export function TimeInput({ value, onChange, className = "", ...rest }: Rest & { value: string; onChange: (hhmm: string) => void }) {
  const [text, setText] = useState(value);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setText(value);
  }, [value, editing]);
  const invalid = text.trim() !== "" && !parseTimeInput(text);
  return (
    <input
      {...rest}
      className={`input time-input ${className}`}
      value={text}
      placeholder="HH:MM"
      inputMode="numeric"
      spellCheck={false}
      aria-invalid={invalid || undefined}
      onChange={(e) => {
        setText(e.target.value);
        const t = parseTimeInput(e.target.value);
        if (t && t !== value) onChange(t);
      }}
      onFocus={() => setEditing(true)}
      onBlur={() => setEditing(false)}
    />
  );
}
