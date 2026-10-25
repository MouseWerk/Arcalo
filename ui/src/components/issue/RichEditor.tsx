// The rich text editor of the issue view (description, comments, text fields): TipTap with the
// nodes Jira's formats have (arcalo_core::issues::richtext). What it cannot edit (an expand, a
// status lozenge, a wiki macro) stays as a non-editable piece and is written back unchanged.
// Mod+Enter saves, Escape cancels (both outside an input-method composition).

import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import { Node, mergeAttributes, type JSONContent } from "@tiptap/core";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { TableKit } from "@tiptap/extension-table";
import { Placeholder } from "@tiptap/extensions";
import { Bold, Code, Italic, Link2, List, ListOrdered, Quote, SquareCode, Strikethrough } from "lucide-react";
import { t } from "../../lib/i18n";
import { isComposing, isKey } from "../../lib/ime";
import { keys } from "../../lib/shortcut";

const Panel = Node.create({
  name: "panel",
  group: "block",
  content: "block+",
  defining: true,
  addAttributes: () => ({ panelType: { default: "info" }, source: { default: null } }),
  parseHTML: () => [{ tag: "div[data-panel]" }],
  renderHTML: ({ node, HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-panel": node.attrs.panelType, class: `jira-panel jira-panel-${node.attrs.panelType}` }), 0],
});

const atom = (name: string, inline: boolean, attrs: Record<string, { default: unknown }>, label: (a: Record<string, unknown>) => string, cls: string) =>
  Node.create({
    name,
    group: inline ? "inline" : "block",
    inline,
    atom: true,
    selectable: true,
    addAttributes: () => attrs,
    parseHTML: () => [{ tag: `${inline ? "span" : "div"}[data-${name}]` }],
    renderHTML: ({ node, HTMLAttributes }) => [inline ? "span" : "div", mergeAttributes(HTMLAttributes, { [`data-${name}`]: "", class: cls, contenteditable: "false" }), label(node.attrs)],
  });

const Mention = atom("mention", true, { id: { default: "" }, label: { default: "" } }, (a) => `@${a.label || a.id}`, "jira-mention");
const Emoji = atom("emoji", true, { shortName: { default: "" }, text: { default: "" } }, (a) => String(a.shortName || a.text), "jira-emoji");
const kept = { format: { default: "adf" }, data: { default: "" }, label: { default: "" } };
const Media = atom("jiraMedia", false, kept, (a) => String(a.label || t("iv.attachmentPiece")), "jira-piece jira-piece-media");
const MediaInline = atom("jiraMediaInline", true, kept, (a) => String(a.label || t("iv.attachmentPiece")), "jira-piece jira-piece-media");
const Preserved = atom("preserved", true, kept, (a) => String(a.label || t("iv.keptPiece")), "jira-piece");
const PreservedBlock = atom("preservedBlock", false, kept, (a) => String(a.label || t("iv.keptPiece")), "jira-piece jira-piece-block");

export interface RichEditorHandle {
  json: () => JSONContent;
  focus: () => void;
  isEmpty: () => boolean;
}

/** A small rich text editor; `onSubmit` on Mod+Enter, `onCancel` on Escape. */
export const RichEditor = forwardRef<RichEditorHandle, { initial: unknown; label: string; placeholder?: string; autofocus?: boolean; compact?: boolean; onSubmit?: () => void; onCancel?: () => void; onChange?: () => void }>(function RichEditor(
  { initial, label, placeholder, autofocus, compact, onSubmit, onCancel, onChange },
  ref,
) {
  const submit = useRef(onSubmit);
  const cancel = useRef(onCancel);
  const change = useRef(onChange);
  submit.current = onSubmit;
  cancel.current = onCancel;
  change.current = onChange;
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: { openOnClick: false, autolink: true, HTMLAttributes: { rel: "noreferrer" } }, heading: { levels: [1, 2, 3, 4, 5, 6] } }),
      TableKit.configure({ table: { resizable: false } }),
      Placeholder.configure({ placeholder: placeholder ?? "" }),
      Panel,
      Mention,
      Emoji,
      Media,
      MediaInline,
      Preserved,
      PreservedBlock,
    ],
    content: (initial as JSONContent) ?? { type: "doc", content: [{ type: "paragraph" }] },
    autofocus: autofocus ? "end" : false,
    editorProps: {
      attributes: { class: "iv-rich-content", "aria-label": label, role: "textbox", "aria-multiline": "true" },
      handleKeyDown: (_view, e) => {
        if (isComposing(e)) return false;
        if (isKey(e, "Enter") && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          submit.current?.();
          return true;
        }
        if (isKey(e, "Escape") && cancel.current) {
          e.preventDefault();
          e.stopPropagation();
          cancel.current();
          return true;
        }
        return false;
      },
    },
    onUpdate: () => change.current?.(),
  });
  useImperativeHandle(ref, () => ({
    json: () => editor?.getJSON() ?? { type: "doc", content: [] },
    focus: () => editor?.commands.focus("end"),
    isEmpty: () => !editor || editor.isEmpty,
  }));
  const [linking, setLinking] = useState(false);
  const [href, setHref] = useState("");
  const active = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: !!e?.isActive("bold"),
      italic: !!e?.isActive("italic"),
      strike: !!e?.isActive("strike"),
      code: !!e?.isActive("code"),
      link: !!e?.isActive("link"),
      bullet: !!e?.isActive("bulletList"),
      ordered: !!e?.isActive("orderedList"),
      quote: !!e?.isActive("blockquote"),
      codeBlock: !!e?.isActive("codeBlock"),
    }),
  });
  if (!editor) return null;
  const chain = () => editor.chain().focus();
  const tool = (on: boolean | undefined, label2: string, Icon: typeof Bold, run: () => void, shortcut?: string) => (
    <button type="button" className={`iv-tool ${on ? "on" : ""}`} aria-pressed={!!on} aria-label={label2} title={shortcut ? `${label2} (${keys(shortcut)})` : label2} onMouseDown={(e) => e.preventDefault()} onClick={run}>
      <Icon size={14} />
    </button>
  );
  const applyLink = () => {
    const url = href.trim();
    if (!url) chain().unsetLink().run();
    else chain().extendMarkRange("link").setLink({ href: /^[a-z]+:/i.test(url) ? url : `https://${url}` }).run();
    setLinking(false);
    setHref("");
  };
  return (
    <div className={`iv-rich ${compact ? "compact" : ""}`}>
      <div className="iv-toolbar" role="toolbar" aria-label={t("iv.formatting")}>
        {tool(active?.bold, t("iv.fmt.bold"), Bold, () => chain().toggleBold().run(), "Mod b")}
        {tool(active?.italic, t("iv.fmt.italic"), Italic, () => chain().toggleItalic().run(), "Mod i")}
        {tool(active?.strike, t("iv.fmt.strike"), Strikethrough, () => chain().toggleStrike().run())}
        {tool(active?.code, t("iv.fmt.code"), Code, () => chain().toggleCode().run())}
        {tool(active?.link, t("iv.fmt.link"), Link2, () => {
          setHref(editor.getAttributes("link").href ?? "");
          setLinking((v) => !v);
        })}
        <span className="iv-tool-sep" aria-hidden />
        {tool(active?.bullet, t("iv.fmt.bullets"), List, () => chain().toggleBulletList().run())}
        {tool(active?.ordered, t("iv.fmt.numbers"), ListOrdered, () => chain().toggleOrderedList().run())}
        {tool(active?.quote, t("iv.fmt.quote"), Quote, () => chain().toggleBlockquote().run())}
        {tool(active?.codeBlock, t("iv.fmt.codeBlock"), SquareCode, () => chain().toggleCodeBlock().run())}
        {linking && (
          <input
            className="input iv-link-input"
            autoFocus
            value={href}
            placeholder="https://"
            aria-label={t("iv.fmt.linkUrl")}
            onChange={(e) => setHref(e.target.value)}
            onKeyDown={(e) => {
              if (isKey(e, "Enter")) {
                e.preventDefault();
                applyLink();
              } else if (isKey(e, "Escape")) {
                e.preventDefault();
                e.stopPropagation();
                setLinking(false);
                editor.commands.focus();
              }
            }}
            onBlur={() => linking && applyLink()}
          />
        )}
      </div>
      <EditorContent editor={editor} />
    </div>
  );
});
