import {
  BookOpen, Box, Briefcase, Bug, Calendar, CalendarDays, ClipboardList, Code2, Database, FileText, Flag,
  Folder, FolderKanban, Globe, GraduationCap, Heart, Layers, Library, Lightbulb, ListTodo, Map, MessageSquare,
  Notebook, Rocket, Shield, Sparkles, Star, Target, Users, Zap, Blocks, LayoutTemplate, Mail, Server, Cloud,
  Terminal, Ticket, BarChart3, Video, Link2, Wrench, Newspaper, Home, KanbanSquare, type LucideIcon,
} from "lucide-react";

/** Page icons users can pick; stored by name in the database. */
export const PAGE_ICONS: Record<string, LucideIcon> = {
  "file-text": FileText,
  notebook: Notebook,
  folder: Folder,
  "folder-kanban": FolderKanban,
  briefcase: Briefcase,
  blocks: Blocks,
  users: Users,
  "book-open": BookOpen,
  library: Library,
  calendar: Calendar,
  "calendar-days": CalendarDays,
  "list-todo": ListTodo,
  "clipboard-list": ClipboardList,
  "message-square": MessageSquare,
  lightbulb: Lightbulb,
  target: Target,
  flag: Flag,
  rocket: Rocket,
  sparkles: Sparkles,
  star: Star,
  bug: Bug,
  code: Code2,
  database: Database,
  globe: Globe,
  layers: Layers,
  box: Box,
  map: Map,
  shield: Shield,
  zap: Zap,
  heart: Heart,
  "graduation-cap": GraduationCap,
  "layout-template": LayoutTemplate,
  link: Link2,
  mail: Mail,
  server: Server,
  cloud: Cloud,
  terminal: Terminal,
  ticket: Ticket,
  chart: BarChart3,
  video: Video,
  wrench: Wrench,
  newspaper: Newspaper,
  home: Home,
  kanban: KanbanSquare,
};

export function PageIcon({ name, size = 16, className }: { name: string | null | undefined; size?: number; className?: string }) {
  const Icon = (name && PAGE_ICONS[name]) || FileText;
  return <Icon size={size} strokeWidth={1.75} className={className} aria-hidden />;
}
