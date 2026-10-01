// What the widgets of a board share besides data: the texts of the „Notiz“ widgets, and a way
// for a widget to change its own settings (a checklist ticking an item, a scratchpad that
// created its page). Changes are saved at once (into the draft while the board is edited).

import { createContext, useContext } from "react";

export interface BoardCtx {
  notes: Record<string, string>;
  setNote: (id: string, text: string) => void;
  /** Merges `patch` into the settings of widget `id`. */
  setConfig: (id: string, patch: Record<string, unknown>) => void;
}

export const BoardContext = createContext<BoardCtx>({ notes: {}, setNote: () => {}, setConfig: () => {} });

export const useBoard = () => useContext(BoardContext);
