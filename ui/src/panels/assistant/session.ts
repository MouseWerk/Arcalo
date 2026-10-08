// Which conversation the chat components show: the side panel's assistant (the default) or
// the chat view in the main area.

import { createContext, useContext } from "react";
import { panelChat, type ChatSession } from "../../store/chat";

export const ChatSessionContext = createContext<ChatSession>(panelChat);

export const useSession = () => useContext(ChatSessionContext);
