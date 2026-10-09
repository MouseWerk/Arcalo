// Floating toolbar above a table while the cursor is in it: rows, columns, delete.

import { useCallback } from "react";
import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import { CellSelection } from "@tiptap/pm/tables";
import { IconButton } from "../components/ui";
import { TABLE_ACTIONS, inHeaderRow, runTableAction } from "./table-actions";
import { useT } from "../lib/i18n";

/** The DOM element of the table around the selection. */
function tableElement(editor: Editor): HTMLElement | null {
  const { $from } = editor.state.selection;
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name !== "table") continue;
    const dom = editor.view.nodeDOM($from.before(d));
    return dom instanceof HTMLElement ? dom : null;
  }
  return null;
}

const PLACEMENT = { placement: "top-end", offset: 6, flip: true, shift: true } as const;

export function TableToolbar({ editor, hidden }: { editor: Editor; hidden: boolean }) {
  const t = useT();
  const header = useEditorState({ editor, selector: ({ editor: e }) => inHeaderRow(e.state) });
  // Stable props: new functions or options make the menu send them again with a transaction on every render of
  // the editor (every key), which lays a long note out once more.
  const shouldShow = useCallback(
    ({ editor: e, state }: { editor: Editor; state: Editor["state"] }) => !hidden && e.isEditable && e.isActive("table") && (state.selection.empty || state.selection instanceof CellSelection),
    [hidden],
  );
  const reference = useCallback(() => {
    const el = tableElement(editor);
    if (!el) return null;
    return { getBoundingClientRect: () => el.getBoundingClientRect(), getClientRects: () => el.getClientRects() };
  }, [editor]);
  return (
    <BubbleMenu
      editor={editor}
      pluginKey="tableToolbar"
      className="bubble table-toolbar"
      shouldShow={shouldShow}
      getReferencedVirtualElement={reference}
      options={PLACEMENT}
    >
      {TABLE_ACTIONS.map((a, i) => (
        <span key={a.id} style={{ display: "contents" }}>
          {(i === 4 || i === 6) && <span className="bubble-sep" />}
          <IconButton
            icon={a.icon}
            label={t(a.title)}
            data-action={a.id}
            className={a.danger ? "danger" : ""}
            disabled={a.bodyOnly && header}
            tooltipSide="top"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => runTableAction(editor, a)}
          />
        </span>
      ))}
    </BubbleMenu>
  );
}
