// Quick capture: what a line becomes (mirrors annalo_core::desktop::classify).

export type CaptureKind = "zeit" | "task" | "note";

export function captureKind(line: string): CaptureKind {
  const t = line.trim();
  const first = t.split(/\s+/)[0]?.toLowerCase() ?? "";
  if (first === "/zeit" || first === "/time") return "zeit";
  if (t.startsWith("- [ ]") || /^todo:?\s+\S/i.test(t)) return "task";
  return "note";
}

export const CAPTURE_HINTS: Record<CaptureKind, string> = {
  zeit: "Enter bucht die Zeit",
  task: "Enter legt eine Aufgabe in der heutigen Tagesnotiz an",
  note: "Enter hängt die Notiz an die heutige Tagesnotiz an",
};
