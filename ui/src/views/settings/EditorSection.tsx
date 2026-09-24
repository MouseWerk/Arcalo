// Settings → Editor: spellcheck, autosave, typing aids, code blocks, link previews, the
// scroll outline and where new pages go.

import { Segmented, Select, Switch } from "../../components/ui";
import { PAGE_ICONS, iconLabel } from "../../components/icons";
import { useT } from "../../lib/i18n";
import type { EditorPrefs } from "../../lib/types";
import { CommitInput, Group, NumberInput, Row, SectionHead, type SectionProps } from "./common";

export function EditorSection({ draft, update }: SectionProps) {
  const t = useT();
  const e = draft.editor;
  const set = (p: Partial<EditorPrefs>) => update({ editor: { ...e, ...p } });
  return (
    <>
      <SectionHead title={t("set.editor.title")} intro={t("set.editor.intro")} />
      <Group title={t("set.editor.writing")}>
        <Row label={t("set.editor.spellcheck")} description={t("set.editor.spellcheckDesc")}>
          <Select value={e.spellcheck} onChange={(ev) => set({ spellcheck: ev.target.value as EditorPrefs["spellcheck"] })} aria-label={t("set.editor.spellcheck")}>
            <option value="de">{t("set.editor.spellDe")}</option>
            <option value="en">{t("set.editor.spellEn")}</option>
            <option value="de-en">{t("set.editor.spellDeEn")}</option>
            <option value="off">{t("set.editor.spellOff")}</option>
          </Select>
        </Row>
        <Row label={t("set.editor.autosave")} description={t("set.editor.autosaveDesc")}>
          <div className="unit-input">
            <NumberInput min={250} max={3000} step={50} value={e.autosave_ms} onCommit={(v) => set({ autosave_ms: v })} aria-label={t("set.editor.autosave")} />
            <span className="faint">ms</span>
          </div>
        </Row>
        <Row label={t("set.editor.smartQuotes")} description={t("set.editor.smartQuotesDesc")}>
          <Switch label={t("set.editor.smartQuotes")} checked={e.smart_quotes} onChange={(v) => set({ smart_quotes: v })} />
        </Row>
        <Row label={t("set.editor.autoPair")} description={t("set.editor.autoPairDesc")}>
          <Switch label={t("set.editor.autoPair")} checked={e.auto_pair} onChange={(v) => set({ auto_pair: v })} />
        </Row>
      </Group>
      <Group title={t("set.editor.code")}>
        <Row label={t("set.editor.tabSize")} description={t("set.editor.tabSizeDesc")}>
          <Segmented
            label={t("set.editor.tabSize")}
            value={String(e.tab_size)}
            options={["2", "4", "8"].map((v) => ({ value: v, label: v }))}
            onChange={(v) => set({ tab_size: Number(v) })}
          />
        </Row>
        <Row label={t("set.editor.lineNumbers")}>
          <Switch label={t("set.editor.lineNumbers")} checked={e.code_line_numbers} onChange={(v) => set({ code_line_numbers: v })} />
        </Row>
      </Group>
      <Group title={t("set.editor.navigation")}>
        <Row label={t("set.editor.hoverPreview")} description={t("set.editor.hoverPreviewDesc")}>
          <div className="unit-input">
            {e.hover_preview && (
              <>
                <NumberInput min={0} max={3000} step={50} value={e.hover_delay_ms} onCommit={(v) => set({ hover_delay_ms: v })} aria-label={t("set.editor.hoverDelay")} />
                <span className="faint">ms</span>
              </>
            )}
            <Switch label={t("set.editor.hoverPreview")} checked={e.hover_preview} onChange={(v) => set({ hover_preview: v })} />
          </div>
        </Row>
        <Row label={t("set.editor.toolbar")} description={t("set.editor.toolbarDesc")}>
          <Switch label={t("set.editor.toolbar")} checked={e.toolbar} onChange={(v) => set({ toolbar: v })} />
        </Row>
        <Row label={t("set.editor.scrollOutline")} description={t("set.editor.scrollOutlineDesc")}>
          <Switch label={t("set.editor.scrollOutline")} checked={e.scroll_outline} onChange={(v) => set({ scroll_outline: v })} />
        </Row>
      </Group>
      <Group title={t("set.editor.newPages")}>
        <Row label={t("set.editor.location")} description={t("set.editor.locationDesc")}>
          <Select value={e.new_page_location} onChange={(ev) => set({ new_page_location: ev.target.value as EditorPrefs["new_page_location"] })} aria-label={t("set.editor.location")}>
            <option value="top">{t("set.editor.locTop")}</option>
            <option value="current">{t("set.editor.locCurrent")}</option>
            <option value="inbox">{t("set.editor.locInbox")}</option>
          </Select>
        </Row>
        {e.new_page_location === "inbox" && (
          <Row label={t("set.editor.inboxTitle")}>
            <CommitInput value={e.inbox_title} onCommit={(v) => set({ inbox_title: v || "Inbox" })} aria-label={t("set.editor.inboxTitle")} />
          </Row>
        )}
        <Row label={t("set.editor.defaultIcon")} description={t("set.editor.defaultIconDesc")}>
          <Select value={e.default_icon ?? ""} onChange={(ev) => set({ default_icon: ev.target.value || null })} aria-label={t("set.editor.defaultIcon")}>
            <option value="">{t("set.editor.iconNone")}</option>
            {Object.keys(PAGE_ICONS).map((i) => (
              <option key={i} value={i}>
                {iconLabel(i)}
              </option>
            ))}
          </Select>
        </Row>
      </Group>
    </>
  );
}
