// What the widgets of a board share besides data: the texts of the „Notiz“ widgets.

import { createContext, useContext } from "react";

export interface BoardCtx {
  notes: Record<string, string>;
  setNote: (id: string, text: string) => void;
}

export const BoardContext = createContext<BoardCtx>({ notes: {}, setNote: () => {} });

export const useBoard = () => useContext(BoardContext);
