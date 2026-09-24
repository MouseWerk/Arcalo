// The header bar on top of every view: history navigation, breadcrumb, actions.

import type { ReactNode } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { useApp, type Tab } from "../store/app";
import { IconButton } from "./ui";

export function NavButtons({ tab }: { tab: Tab }) {
  const s = useApp.getState;
  return (
    <div className="vh-nav">
      <IconButton icon={ArrowLeft} label="Zurück (Alt ←)" size="md" disabled={!tab.back.length} onClick={() => s().goBack()} />
      <IconButton icon={ArrowRight} label="Vorwärts (Alt →)" size="md" disabled={!tab.forward.length} onClick={() => s().goForward()} />
    </div>
  );
}

/** `center` replaces the breadcrumb and title (a page with the editor toolbar). */
export function ViewHeader({ tab, crumbs, title, actions, center }: { tab: Tab; crumbs?: ReactNode; title: ReactNode; actions?: ReactNode; center?: ReactNode }) {
  return (
    <div className="vh">
      <NavButtons tab={tab} />
      {center ?? (
        <div className="vh-title">
          {crumbs}
          <span className="vh-title-text">{title}</span>
        </div>
      )}
      <div className="vh-actions">{actions}</div>
    </div>
  );
}
