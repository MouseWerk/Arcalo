// Which component shows which widget kind, its icon, and where its title leads.

import type { ComponentType } from "react";
import {
  Activity,
  CalendarClock,
  CalendarDays,
  CheckSquare,
  Clock,
  FileText,
  FolderKanban,
  Gauge,
  History,
  Link2,
  ListFilter,
  Pin,
  Sparkles,
  Star,
  StickyNote,
  Sun,
  Sunset,
  Target,
  Timer,
  TrendingUp,
  WandSparkles,
  type LucideIcon,
} from "lucide-react";
import type { WidgetKind } from "../../lib/dashboard";
import type { GridWidget } from "../../lib/types";
import { openCalendarView } from "../../lib/calnav";
import { openDayReview } from "../../lib/reviewnav";
import { useApp } from "../../store/app";
import { AgendaWidget, CalendarWidget, ClockWidget, FocusWidget, ReviewWidget, TasksWidget, TodayWidget } from "./day";
import { BudgetWidget, ProjectWidget, ProposalWidget, TimerWidget, WeekWidget } from "./time";
import { ActivityWidget, EmbedWidget, FavoritesWidget, NoteWidget, PinnedWidget, RecentWidget } from "./pages";
import { LinksWidget, QueryWidget, SuggestionsWidget } from "./tools";

export interface WidgetProps {
  widget: GridWidget;
  openSettings: () => void;
}

export const BODIES: Record<WidgetKind, ComponentType<WidgetProps>> = {
  today: TodayWidget,
  agenda: AgendaWidget,
  tasks: TasksWidget,
  focus: FocusWidget,
  clock: ClockWidget,
  review: ReviewWidget,
  calendar: CalendarWidget,
  week: WeekWidget,
  timer: TimerWidget,
  budget: BudgetWidget,
  project: ProjectWidget,
  proposal: ProposalWidget,
  recent: RecentWidget,
  favorites: FavoritesWidget,
  pinned: PinnedWidget,
  note: NoteWidget,
  embed: EmbedWidget,
  activity: ActivityWidget,
  query: QueryWidget,
  links: LinksWidget,
  suggestions: SuggestionsWidget,
};

export const ICONS: Record<WidgetKind, LucideIcon> = {
  today: Sun,
  agenda: CalendarClock,
  tasks: CheckSquare,
  focus: Target,
  clock: Clock,
  review: Sunset,
  calendar: CalendarDays,
  week: TrendingUp,
  timer: Timer,
  budget: Gauge,
  project: FolderKanban,
  proposal: WandSparkles,
  recent: History,
  favorites: Star,
  pinned: Pin,
  note: StickyNote,
  embed: FileText,
  activity: Activity,
  query: ListFilter,
  links: Link2,
  suggestions: Sparkles,
};

const s = useApp.getState;

/** Where a click on the widget's title leads (none for widgets that are the thing itself). */
export function openerOf(w: GridWidget): (() => void) | null {
  const c = w.config ?? {};
  switch (w.kind as WidgetKind) {
    case "agenda":
      return () => openCalendarView();
    case "tasks":
      return () => s().openTab({ kind: "tasks" });
    case "week":
    case "timer":
    case "proposal":
      return () => s().openTab({ kind: "timesheet" });
    case "budget":
    case "project":
      return () => s().openTab({ kind: "projects" });
    case "activity":
      return () => s().openTab({ kind: "activity" });
    case "review":
      return () => openDayReview();
    case "embed":
      return typeof c.page === "number" ? () => s().openPage(c.page as number) : null;
    default:
      return null;
  }
}
