// Which component shows which widget kind, its icon, and where its title leads: the built-in
// kinds below, and the kinds the files in ./widgets register with `defineWidget` (define.ts),
// all loaded here with the start page.

import { timeTrackingEnabled } from "../../lib/timetracking";
import type { ComponentType } from "react";
import {
  Activity,
  CalendarClock,
  CalendarDays,
  CheckSquare,
  LayoutGrid,
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
  Ticket,
  Timer,
  Kanban,
  ListTodo,
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
import { viewOf } from "./define";
import { WORK_BODIES, WORK_ICONS, workOpener } from "./work";
import { JiraMineWidget, JiraQueryWidget, JiraSprintWidget } from "./jira";

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
  ...WORK_BODIES,
  jira: JiraMineWidget,
  jira_query: JiraQueryWidget,
  jira_sprint: JiraSprintWidget,
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
  ...WORK_ICONS,
  jira: Ticket,
  jira_query: ListTodo,
  jira_sprint: Kanban,
};

/** The component of a kind: built in or registered. */
export function bodyOf(kind: string): ComponentType<WidgetProps> | undefined {
  return Object.hasOwn(BODIES, kind) ? BODIES[kind as WidgetKind] : viewOf(kind)?.body;
}

/** The icon of a kind: built in or registered. */
export function iconOf(kind: string): LucideIcon {
  return (Object.hasOwn(ICONS, kind) ? ICONS[kind as WidgetKind] : viewOf(kind)?.icon) ?? LayoutGrid;
}

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
      return timeTrackingEnabled() ? () => s().openTab({ kind: "projects" }) : null;
    case "activity":
      return () => s().openTab({ kind: "activity" });
    case "review":
      return () => openDayReview();
    case "jira":
    case "jira_query":
    case "jira_sprint":
      return () => s().openTab({ kind: "issues" });
    case "embed":
      return typeof c.page === "number" ? () => s().openPage(c.page as number) : null;
    default:
      return viewOf(w.kind)?.opener?.(w) ?? workOpener(w);
  }
}

// Every widget file in ./widgets registers itself (define.ts); nothing else needs to list it.
import.meta.glob("./widgets/*.tsx", { eager: true });
