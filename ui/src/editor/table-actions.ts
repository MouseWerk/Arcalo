// Table editing commands, shared by the table toolbar and the slash menu.

import type { ChainedCommands, Editor } from "@tiptap/core";
import type { EditorState } from "@tiptap/pm/state";
import {
  BetweenHorizontalEnd, BetweenHorizontalStart, BetweenVerticalEnd, BetweenVerticalStart, TableColumnsSplit, TableRowsSplit, Trash2, type LucideIcon,
} from "lucide-react";
import { type TKey } from "../lib/i18n";

export interface TableAction {
  id: string;
  /** Catalog key of the label. */
  title: TKey;
  icon: LucideIcon;
  keywords: string;
  danger?: boolean;
  /** Not available in the header row: Markdown tables always keep exactly one header row. */
  bodyOnly?: boolean;
  run: (chain: ChainedCommands) => ChainedCommands;
}

export const TABLE_ACTIONS: TableAction[] = [
  { id: "row-above", title: "table.rowAbove", icon: BetweenHorizontalStart, keywords: "tabelle table zeile row oben above einfügen insert", bodyOnly: true, run: (c) => c.addRowBefore() },
  { id: "row-below", title: "table.rowBelow", icon: BetweenHorizontalEnd, keywords: "tabelle table zeile row unten below einfügen insert", run: (c) => c.addRowAfter() },
  { id: "col-left", title: "table.colLeft", icon: BetweenVerticalStart, keywords: "tabelle table spalte column links left einfügen insert", run: (c) => c.addColumnBefore() },
  { id: "col-right", title: "table.colRight", icon: BetweenVerticalEnd, keywords: "tabelle table spalte column rechts right einfügen insert", run: (c) => c.addColumnAfter() },
  { id: "row-delete", title: "table.rowDelete", icon: TableRowsSplit, keywords: "tabelle table zeile row entfernen remove löschen delete", danger: true, bodyOnly: true, run: (c) => c.deleteRow() },
  { id: "col-delete", title: "table.colDelete", icon: TableColumnsSplit, keywords: "tabelle table spalte column entfernen remove löschen delete", danger: true, run: (c) => c.deleteColumn() },
  { id: "table-delete", title: "table.delete", icon: Trash2, keywords: "tabelle table entfernen remove löschen delete", danger: true, run: (c) => c.deleteTable() },
];

/** Whether the selection is in the first (header) row of a table. */
export function inHeaderRow(state: EditorState): boolean {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name === "tableRow") return $from.index(d - 1) === 0;
  }
  return false;
}

/** The actions available at the current selection. */
export const tableActionEnabled = (state: EditorState, a: TableAction) => !(a.bodyOnly && inHeaderRow(state));

export const runTableAction = (editor: Editor, a: TableAction) => tableActionEnabled(editor.state, a) && a.run(editor.chain().focus()).run();
