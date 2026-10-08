// What `dashboard_data` answers per part (arcalo_core::dashboard, serde snake_case).

import type { Activity, BudgetStatus, CalendarEvent, DayOverview, FocusReport, Page, Task, TimeEntryRow } from "./types";

export interface TodayData {
  date: string;
  daily_note_id: number | null;
  booked_minutes: number;
  target_minutes: number;
  workday: boolean;
  events: CalendarEvent[];
  tasks: Task[];
  tasks_total: number;
  focus: FocusReport;
  calendar_configured: boolean;
}
export interface AgendaData {
  from: string;
  to: string;
  events: CalendarEvent[];
  configured: boolean;
}
export interface TasksData {
  tasks: Task[];
  total: number;
}
export interface WeekData {
  week_start: string;
  days: { date: string; minutes: number; workday: boolean }[];
  wbs: { label: string; title: string; minutes: number; by_day: number[] }[];
  target_minutes: number;
}
export interface BudgetRow extends BudgetStatus {
  title: string;
  recent_hours: number;
}
export interface BudgetsData {
  budgets: BudgetRow[];
  burn_days: number;
}
export interface ProjectData {
  netzplan_id: number;
  netzplan_nr: string;
  description: string;
  project_code: string;
  project_name: string;
  budget: BudgetRow[];
  pages: Page[];
  tasks: Task[];
  tasks_total: number;
  events: CalendarEvent[];
  burn_days: number;
}
export interface PageData {
  id: number;
  title: string;
  icon: string | null;
  updated_at: string;
  content: string;
  truncated: boolean;
}
export interface FocusData {
  today: FocusReport;
  week: FocusReport;
}
export interface ProposalData {
  week_start: string;
  open_days: { date: string; booked_minutes: number; missing_minutes: number }[];
  missing_minutes: number;
  unbooked_meetings: number;
  unbooked_minutes: number;
  booked_minutes: number;
  target_minutes: number;
}
export interface ReviewLine {
  label: string;
  minutes: number;
  page_id: number | null;
  icon: string | null;
}
export interface ReviewData {
  date: string;
  workday: boolean;
  booked_minutes: number;
  target_minutes: number;
  pages_edited: number;
  pages_created: number;
  tasks_done: number;
  tasks_added: number;
  meetings: number;
  meetings_open: number;
  focus_minutes: number;
  top_wbs: ReviewLine[];
  top_pages: ReviewLine[];
  empty: boolean;
}
export interface SuggestionData {
  open_tasks: number;
  overdue: number;
  due_today: number;
  worst_budget: string | null;
  week_minutes: number[];
}
export interface QueryRow {
  key: string;
  title: string;
  detail: string;
  date: string | null;
  page_id: number | null;
  icon: string | null;
  ordinal: number | null;
  done: boolean | null;
  priority: number | null;
  minutes: number | null;
  event_key: string | null;
  cells: Record<string, string>;
}
export interface QueryResult {
  total: number;
  minutes: number | null;
  rows: QueryRow[];
  groups: { label: string; value: number }[];
}
export type FeedData = Activity[];
export type RecentData = Page[];
export type TimerRefsData = TimeEntryRow[];
export type MonthData = DayOverview[];
