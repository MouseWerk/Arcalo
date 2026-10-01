// Icons of the assistant's tools and suggestions.

import { CalendarRange, FileText, Gauge, GitBranch, Globe, History, ListChecks, Search, Sparkles, Terminal, Timer, type LucideIcon } from "lucide-react";
import type { SuggestionKind } from "../../lib/suggestions";

export const TOOL_ICONS: Record<string, LucideIcon> = {
  log_time: Timer,
  search_workspace: Search,
  budget_status: Gauge,
  list_tasks: ListChecks,
  time_summary: CalendarRange,
  activity_log: History,
  run_powershell: Terminal,
  git: GitBranch,
  http_request: Globe,
};

export const SUGGESTION_ICONS: Record<SuggestionKind, LucideIcon> = {
  page: FileText,
  tasks: ListChecks,
  time: Timer,
  budget: Gauge,
  report: CalendarRange,
  plan: Sparkles,
};
