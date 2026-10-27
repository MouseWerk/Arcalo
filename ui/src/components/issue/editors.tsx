// The edit controls of the issue view, one per kind of field Jira's `editmeta` names: text, rich
// text, numbers, dates, single and multiple choices, cascading choices, users (with search) and
// labels. Each saves explicitly (Enter or „Speichern“) and cancels with Escape, outside an
// input-method composition. A conflict (the issue changed in Jira meanwhile) shows the value Jira
// has now; nothing is overwritten unless the user says so.

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, X } from "lucide-react";
import { Button, IconButton, Input, Select } from "../ui";
import { DateInput, TimeInput } from "../DateInput";
import { fmtDate, dateTime, relative } from "../../lib/format";
import { t } from "../../lib/i18n";
import { isComposing, isKey } from "../../lib/ime";
import { keys } from "../../lib/shortcut";
import { fullApi, jiraDate, jiraIso, type EditField, type FieldInput, type IssueFull, type JUser, type Shown } from "../../lib/issueFull";
import { Avatar, JiraHtml, UserChip, followLink } from "./media";
import { RichEditor, type RichEditorHandle } from "./RichEditor";

// ------------------------------------------------------------------ showing values

/** A field's value as the details show it. */
export function ShownValue({ value, issue, onIssue }: { value: Shown; issue: IssueFull; onIssue?: (key: string) => void }) {
  switch (value.t) {
    case "text":
      return <span className="iv-text">{value.v}</span>;
    case "html":
      return <JiraHtml html={value.v} issue={issue} className="iv-field-html" />;
    case "number":
      return <span className="tabular">{value.v.toLocaleString()}</span>;
    case "date":
      return <span>{fmtDate(`${value.v}T12:00:00`)}</span>;
    case "date_time":
      return <span>{jiraDate(value.v) ? dateTime(jiraIso(value.v)) : value.v}</span>;
    case "options":
      return (
        <span className="iv-chips">
          {value.v.map((o) => (
            <span key={o} className="iv-chip">
              {o}
            </span>
          ))}
        </span>
      );
    case "users":
      return (
        <span className="iv-users">
          {value.v.map((u) => (
            <UserChip key={u.id || u.name} user={u} site={issue.site} />
          ))}
        </span>
      );
    case "link":
      return (
        <a className="iv-link" href={value.v.url} onClick={(e) => (e.preventDefault(), followLink(value.v.url))}>
          {value.v.label}
        </a>
      );
    case "issue":
      return (
        <button type="button" className="iv-keylink mono" onClick={() => onIssue?.(value.v)}>
          {value.v}
        </button>
      );
    case "sprints":
      return (
        <span className="iv-chips">
          {value.v.map((s) => (
            <span key={s.name} className={`iv-chip ${s.state === "active" ? "strong" : ""}`}>
              {s.name}
            </span>
          ))}
        </span>
      );
    case "cascade":
      return <span>{value.v[1] ? `${value.v[0]} › ${value.v[1]}` : value.v[0]}</span>;
  }
}

// ------------------------------------------------------------------ users

/** Searches users (assignable ones for the assignee) and picks one. */
export function UserPicker({ issue, assignable, label, onPick, exclude = [] }: { issue: IssueFull; assignable: boolean; label: string; onPick: (u: JUser) => void; exclude?: string[] }) {
  const [q, setQ] = useState("");
  const [list, setList] = useState<JUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState(0);
  const seq = useRef(0);
  useEffect(() => {
    const n = ++seq.current;
    const timer = window.setTimeout(() => {
      fullApi.users(issue.key, q, assignable).then(
        (l) => n === seq.current && (setList(l.filter((u) => !exclude.includes(u.id))), setError(null), setSel(0)),
        (e) => n === seq.current && (setList([]), setError(String(e))),
      );
    }, 180);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, issue.key, assignable]);
  return (
    <div className="iv-picker">
      <Input
        autoFocus
        value={q}
        placeholder={t("iv.userSearch")}
        aria-label={label}
        role="combobox"
        aria-expanded={!!list?.length}
        aria-autocomplete="list"
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (isComposing(e) || !list) return;
          if (e.key === "ArrowDown") (e.preventDefault(), setSel((v) => Math.min(v + 1, list.length - 1)));
          else if (e.key === "ArrowUp") (e.preventDefault(), setSel((v) => Math.max(v - 1, 0)));
          else if (isKey(e, "Enter") && list[sel]) {
            e.preventDefault();
            e.stopPropagation();
            onPick(list[sel]);
          }
        }}
      />
      <ul className="iv-picker-list" role="listbox" aria-label={label}>
        {error && <li className="faint small">{error}</li>}
        {list?.length === 0 && !error && <li className="faint small">{t("iv.noUsers")}</li>}
        {list?.map((u, i) => (
          <li key={u.id} role="option" aria-selected={i === sel}>
            <button type="button" className={`iv-picker-item ${i === sel ? "sel" : ""}`} onMouseEnter={() => setSel(i)} onClick={() => onPick(u)}>
              <Avatar user={u} site={issue.site} size="sm" />
              <span className="ellipsis">{u.name}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ------------------------------------------------------------------ labels

function LabelsInput({ value, onChange, onSubmit, label }: { value: string[]; onChange: (v: string[]) => void; onSubmit: () => void; label: string }) {
  const [draft, setDraft] = useState("");
  const add = (raw: string) => {
    const parts = raw.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
    if (parts.length) onChange([...value, ...parts.filter((p) => !value.includes(p))]);
    setDraft("");
  };
  return (
    <div className="iv-labels-input">
      {value.map((l) => (
        <span key={l} className="iv-chip">
          {l}
          <button type="button" className="iv-chip-x" aria-label={t("iv.removeLabel", { label: l })} onClick={() => onChange(value.filter((x) => x !== l))}>
            <X size={11} />
          </button>
        </span>
      ))}
      <input
        className="iv-labels-draft"
        autoFocus
        value={draft}
        aria-label={label}
        placeholder={t("iv.labelAdd")}
        onChange={(e) => (/[\s,]$/.test(e.target.value) ? add(e.target.value) : setDraft(e.target.value))}
        onKeyDown={(e) => {
          if (isComposing(e)) return;
          if (isKey(e, "Enter")) {
            e.preventDefault();
            if (draft.trim()) add(draft);
            else onSubmit();
          } else if (e.key === "Backspace" && !draft && value.length) onChange(value.slice(0, -1));
        }}
        onBlur={() => draft.trim() && add(draft)}
      />
    </div>
  );
}

// ------------------------------------------------------------------ one field

/** Splits a Jira date and time input into day and time for the controls. */
function dayAndTime(iso: string | null): [string, string] {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return ["", ""];
  const pad = (n: number) => String(n).padStart(2, "0");
  return [`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, `${pad(d.getHours())}:${pad(d.getMinutes())}`];
}

/** Whether an input can be saved as it is (required fields not empty). */
export function inputFilled(f: EditField, v: FieldInput | null): boolean {
  if (!v) return false;
  if (!f.required) return true;
  switch (v.t) {
    case "text":
      return v.v.trim() !== "";
    case "choices":
    case "users":
    case "labels":
      return v.v.length > 0;
    case "cascade":
      return !!v.v[0];
    case "estimates":
      return !!(v.v[0]?.trim() || v.v[1]?.trim());
    case "doc":
      return true;
    default:
      return v.v != null && v.v !== "";
  }
}

/**
 * The control for `field`, started at `value`. `onSave` gets the new input; `bare` leaves out the
 * save and cancel buttons (a transition screen saves all its fields at once).
 */
export function FieldControl({ issue, field, value, onChange, onSave, onCancel, busy, bare }: { issue: IssueFull; field: EditField; value: FieldInput | null; onChange: (v: FieldInput) => void; onSave?: (input?: FieldInput) => void; onCancel?: () => void; busy?: boolean; bare?: boolean }) {
  const rich = useRef<RichEditorHandle>(null);
  const keyDown = (e: React.KeyboardEvent) => {
    if (isComposing(e)) return;
    if (isKey(e, "Enter") && onSave && !(e.target instanceof HTMLTextAreaElement)) {
      e.preventDefault();
      e.stopPropagation();
      onSave();
    } else if (isKey(e, "Escape") && onCancel) {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    }
  };
  const label = field.name;
  const none = { value: "", label: t("iv.none") };
  let control: React.ReactNode = null;
  switch (field.kind) {
    case "text":
    case "url":
      control = <Input autoFocus={!bare} value={value?.t === "text" ? value.v : ""} aria-label={label} onChange={(e) => onChange({ t: "text", v: e.target.value })} onKeyDown={keyDown} />;
      break;
    case "number":
      control = (
        <Input
          autoFocus={!bare}
          inputMode="decimal"
          value={value?.t === "number" && value.v != null ? String(value.v) : ""}
          aria-label={label}
          onChange={(e) => {
            const n = parseFloat(e.target.value.replace(",", "."));
            onChange({ t: "number", v: e.target.value.trim() === "" || Number.isNaN(n) ? null : n });
          }}
          onKeyDown={keyDown}
        />
      );
      break;
    case "date":
      control = (
        <div className="iv-row-controls" onKeyDown={keyDown}>
          <DateInput value={value?.t === "date" ? (value.v ?? "") : ""} aria-label={label} onChange={(iso) => onChange({ t: "date", v: iso || null })} />
          {!field.required && value?.t === "date" && value.v && <IconButton icon={X} size="sm" label={t("iv.clear")} onClick={() => onChange({ t: "date", v: null })} />}
        </div>
      );
      break;
    case "date_time": {
      const [day, hm] = dayAndTime(value?.t === "date" ? value.v : null);
      const set = (d: string, h: string) => onChange({ t: "date", v: d ? new Date(`${d}T${h || "09:00"}:00`).toISOString() : null });
      control = (
        <div className="iv-row-controls" onKeyDown={keyDown}>
          <DateInput value={day} aria-label={label} onChange={(d) => set(d, hm)} />
          <TimeInput value={hm} aria-label={t("iv.timeOf", { field: label })} onChange={(h) => set(day, h)} />
        </div>
      );
      break;
    }
    case "select":
      control = (
        <div onKeyDown={keyDown}>
          <Select aria-label={label} value={value?.t === "choice" ? (value.v ?? "") : ""} onChange={(e) => onChange({ t: "choice", v: e.target.value || null })} options={[...(field.required ? [] : [none]), ...field.allowed.map((c) => ({ value: c.id, label: c.label }))]} />
        </div>
      );
      break;
    case "multi_select": {
      const ids = value?.t === "choices" ? value.v : [];
      control = (
        <div className="iv-checks" role="group" aria-label={label} onKeyDown={keyDown}>
          {field.allowed.map((c) => (
            <label key={c.id} className="iv-check">
              <input type="checkbox" className="check" checked={ids.includes(c.id)} onChange={(e) => onChange({ t: "choices", v: e.target.checked ? [...ids, c.id] : ids.filter((x) => x !== c.id) })} />
              <span>{c.label}</span>
            </label>
          ))}
        </div>
      );
      break;
    }
    case "cascade": {
      const [p, c] = value?.t === "cascade" ? value.v : [null, null];
      const parent = field.allowed.find((x) => x.id === p);
      control = (
        <div className="iv-row-controls" onKeyDown={keyDown}>
          <Select aria-label={label} value={p ?? ""} onChange={(e) => onChange({ t: "cascade", v: [e.target.value || null, null] })} options={[...(field.required ? [] : [none]), ...field.allowed.map((x) => ({ value: x.id, label: x.label }))]} />
          {parent && parent.children.length > 0 && (
            <Select aria-label={t("iv.cascadeChild", { field: label })} value={c ?? ""} onChange={(e) => onChange({ t: "cascade", v: [p, e.target.value || null] })} options={[none, ...parent.children.map((x) => ({ value: x.id, label: x.label }))]} />
          )}
        </div>
      );
      break;
    }
    case "user":
      control = (
        <div onKeyDown={keyDown}>
          <UserPicker
            issue={issue}
            assignable={field.id === "assignee"}
            label={label}
            onPick={(u) => {
              onChange({ t: "user", v: u.id });
              onSave?.({ t: "user", v: u.id });
            }}
          />
          {!field.required && (
            <Button size="sm" variant="ghost" onClick={() => (onChange({ t: "user", v: null }), onSave?.({ t: "user", v: null }))}>
              {field.id === "assignee" ? t("iv.unassign") : t("iv.clear")}
            </Button>
          )}
        </div>
      );
      break;
    case "users": {
      const ids = value?.t === "users" ? value.v : [];
      control = (
        <div onKeyDown={keyDown}>
          <div className="iv-chips">
            {ids.map((id) => (
              <span key={id} className="iv-chip">
                {id}
                <button type="button" className="iv-chip-x" aria-label={t("iv.removeUser", { name: id })} onClick={() => onChange({ t: "users", v: ids.filter((x) => x !== id) })}>
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
          <UserPicker issue={issue} assignable={false} label={label} exclude={ids} onPick={(u) => onChange({ t: "users", v: [...ids, u.id] })} />
        </div>
      );
      break;
    }
    case "time_tracking": {
      const [original, remaining] = value?.t === "estimates" ? value.v : [null, null];
      control = (
        <div className="iv-row-controls" onKeyDown={keyDown}>
          <label className="iv-mini-field">
            <span>{t("iv.timeOriginal")}</span>
            <Input autoFocus={!bare} value={original ?? ""} placeholder={t("iv.durationPh")} aria-label={t("iv.timeOriginal")} onChange={(e) => onChange({ t: "estimates", v: [e.target.value, remaining] })} />
          </label>
          <label className="iv-mini-field">
            <span>{t("iv.timeRemaining")}</span>
            <Input value={remaining ?? ""} placeholder={t("iv.durationPh")} aria-label={t("iv.timeRemaining")} onChange={(e) => onChange({ t: "estimates", v: [original, e.target.value] })} />
          </label>
        </div>
      );
      break;
    }
    case "labels":
      control = <LabelsInput label={label} value={value?.t === "labels" ? value.v : []} onChange={(v) => onChange({ t: "labels", v })} onSubmit={() => onSave?.()} />;
      break;
    case "rich":
      control = (
        <>
          {field.lossy.length > 0 && <div className="iv-note small">{t("iv.lossy", { what: field.lossy.join(", ") })}</div>}
          <RichEditor ref={rich} initial={value?.t === "doc" ? value.v : null} label={label} autofocus={!bare} onChange={() => onChange({ t: "doc", v: rich.current?.json() })} onSubmit={() => onSave?.()} onCancel={onCancel} />
        </>
      );
      break;
    default:
      control = <span className="faint small">{t("iv.notEditable")}</span>;
  }
  if (bare) return <>{control}</>;
  return (
    <div className="iv-editor" data-field={field.id}>
      {control}
      <div className="iv-editor-actions">
        <Button size="sm" variant="primary" icon={Check} loading={busy} disabled={!inputFilled(field, value)} onClick={() => onSave?.()}>
          {t("iv.save")}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => onCancel?.()}>
          {t("common.cancel")}
        </Button>
        {field.kind === "rich" && <span className="faint small">{t("iv.richHint", { keys: keys("Mod Enter") })}</span>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ conflicts

export interface Conflict {
  field: string;
  updated: string;
  value: Shown | null;
  by: JUser | null;
  /** What the user wanted to save. */
  input: FieldInput;
}

/** Someone changed the issue in Jira meanwhile: what is there now, and the two ways on. */
export function ConflictNotice({ conflict, issue, onReload, onOverwrite, busy }: { conflict: Conflict; issue: IssueFull; onReload: () => void; onOverwrite: () => void; busy?: boolean }) {
  const when = jiraIso(conflict.updated);
  return (
    <div className="iv-conflict" role="alert">
      <div className="iv-conflict-head">
        <b>{t("iv.conflict")}</b>
        <span className="faint small">{conflict.by ? t("iv.conflictBy", { name: conflict.by.name, when: when ? relative(when) : "" }) : when ? relative(when) : ""}</span>
      </div>
      <div className="iv-conflict-value">
        <span className="faint small">{t("iv.conflictNow")}</span>
        {conflict.value ? <ShownValue value={conflict.value} issue={issue} /> : <span className="faint">{t("iv.empty")}</span>}
      </div>
      <div className="iv-editor-actions">
        <Button size="sm" variant="primary" onClick={onReload}>
          {t("iv.conflictReload")}
        </Button>
        <Button size="sm" variant="ghost" loading={busy} onClick={onOverwrite}>
          {t("iv.conflictOverwrite")}
        </Button>
      </div>
    </div>
  );
}

/** The editable fields of `issue` that the details list, by name. */
export function useEditableFields(issue: IssueFull, placed: Set<string>) {
  return useMemo(() => issue.edit.filter((f) => !placed.has(f.id) && f.kind !== "unsupported"), [issue.edit, placed]);
}
