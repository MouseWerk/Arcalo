// Widgets of the start page that live in files of their own register here: one `defineWidget`
// call per kind, at the top level of a file in `components/dashboard/widgets/`. Every file in
// that folder is loaded with the start page (registry.tsx), so a new widget touches no shared
// list. The full guide is in docs/ARCHITECTURE.md („Start page widgets“); in short:
//
//   defineWidget({
//     kind: "standup",                      // unique, lower case (a-z, 0-9, -, _)
//     label: "dash.w.standup", hint: "dash.w.standupHint",   // keys in ui/src/locales
//     group: "tools",                       // gallery group: day, time, pages, tools
//     size: { w: 4, h: 7 }, min: { w: 3, h: 4 },             // grid cells (12 columns)
//     config: () => ({ team: "" }),         // settings of a new widget
//     icon: Users, body: StandupWidget,     // lucide icon, component ({ widget, openSettings })
//     settings: StandupSettings,            // optional: fields in the settings dialog
//     parts: (c) => [...],                  // optional: data from the batched `dashboard_data`
//     secrets: ["account"],                 // optional: keys never exported
//     time: true,                           // optional: hidden while time tracking is off
//   });
//
// A body reads its settings with `configOf(widget)`, changes them with `useBoard().setConfig`,
// and loads data either through `parts` + `useWidgetData` or with `useLazyData` (data.tsx).
// Both load only once the widget scrolls into view.

import type { ComponentType } from "react";
import type { LucideIcon } from "lucide-react";
import { registerWidgetDef, type WidgetDef } from "../../lib/dashboard";
import type { GridWidget } from "../../lib/types";
import type { WidgetProps } from "./registry";

/** The schematic the gallery shows for a widget. */
export type GalleryLook = "list" | "bars" | "ring" | "timeline" | "clock" | "grid" | "text" | "tiles" | "hbars";

/** What a widget's own fields in the settings dialog get. */
export interface SettingsProps {
  widget: GridWidget;
  /** The settings being edited (with the kind's defaults). */
  config: Record<string, unknown>;
  /** Merges a change into the settings (applied with „Übernehmen“). */
  set: (patch: Record<string, unknown>) => void;
}

export interface WidgetView {
  body: ComponentType<WidgetProps>;
  icon: LucideIcon;
  look?: GalleryLook;
  settings?: ComponentType<SettingsProps>;
  /** Where a click on the title leads (none: the title is plain text). */
  opener?: (w: GridWidget) => (() => void) | null;
}

export interface WidgetSpec extends WidgetDef, WidgetView {
  kind: string;
}

const VIEWS = new Map<string, WidgetView>();

/** Registers a widget kind: its catalogue entry (lib/dashboard.ts) and its component. */
export function defineWidget(spec: WidgetSpec): void {
  const { kind, body, icon, look, settings, opener, ...def } = spec;
  registerWidgetDef(kind, def);
  VIEWS.set(kind, { body, icon, look, settings, opener });
}

/** The component and icon of a registered kind. */
export const viewOf = (kind: string): WidgetView | undefined => VIEWS.get(kind);
