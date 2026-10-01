// Icons of the assistant's tools and suggestions.

import { ArrowRightLeft, CalendarRange, FileText, Gauge, GitBranch, Globe, History, ListChecks, MessageSquare, Search, Sparkles, Terminal, Ticket, Timer, type LucideIcon } from "lucide-react";
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
  jira_search: Ticket,
  jira_issue: Ticket,
  jira_my_issues: Ticket,
  jira_comment: MessageSquare,
  jira_transition: ArrowRightLeft,
};

export const SUGGESTION_ICONS: Record<SuggestionKind, LucideIcon> = {
  page: FileText,
  tasks: ListChecks,
  time: Timer,
  budget: Gauge,
  report: CalendarRange,
  plan: Sparkles,
};
