import { describe, expect, it } from "vitest";
import { REVIEW_CLOSE, REVIEW_OPEN, cleanSummary, findReviewBlock, hm, hours, localProviders, progress, reviewMarkdown, shiftDay, upsertReviewBlock } from "./dayreview";
import type { AiProvider, DayReview } from "./types";

/** A local time on the review day as ISO (the block shows local times). */
const at = (h: number, m = 0) => new Date(2026, 8, 24, h, m).toISOString();

function review(patch: Partial<DayReview> = {}): DayReview {
  return {
    date: "2026-09-24",
    from: at(0),
    to: at(24),
    daily_note_id: 7,
    pages: [
      { page_id: 3, title: "Konzept Portal", icon: null, gone: false, created: true, daily: false, edits: 4, chars: 300, minutes: 8, first_at: at(9), last_at: at(10), word_delta: 42 },
      { page_id: 7, title: "24.09.2026", icon: "calendar", gone: false, created: false, daily: true, edits: 2, chars: 20, minutes: 4, first_at: at(8), last_at: at(8, 30), word_delta: 3 },
      { page_id: null, title: "Alt [[x]]", icon: null, gone: true, created: false, daily: false, edits: 1, chars: 5, minutes: 2, first_at: at(11), last_at: at(11), word_delta: null },
    ],
    time: {
      target_minutes: 480,
      workday: true,
      booked_minutes: 390,
      running_minutes: 0,
      missing_minutes: 90,
      items: [
        { label: "NP-8801/1020", project_code: "PRJ", netzplan_id: 1, vorgang_nr: "1020", title: "Schnittstellen", minutes: 300, entries: 3, descriptions: ["Konzept"] },
        { label: "NP-8801", project_code: "PRJ", netzplan_id: 1, vorgang_nr: null, title: "Integration", minutes: 90, entries: 1, descriptions: [] },
      ],
      entries: [],
      gaps: [{ start: at(10, 30), end: at(13), minutes: 150 }],
    },
    tasks: {
      done: [{ page_id: 3, page_title: "Konzept Portal", text: "Angebot schreiben", at: at(10), due: null, done: true }],
      added: [
        { page_id: 3, page_title: "Konzept Portal", text: "Angebot schreiben", at: at(9), due: null, done: true },
        { page_id: 3, page_title: "Konzept Portal", text: "Review", at: at(9), due: null, done: false },
      ],
      due: [],
      overdue: [{ page_id: 4, page_title: "Aufgaben", text: "Alt", at: null, due: "2026-09-20", done: false }],
      done_total: 1,
      added_total: 2,
      due_total: 0,
      overdue_total: 1,
    },
    meetings: [
      { key: "a", source: "ics:a", title: "Jour fixe", start: at(9), end: at(10), all_day: false, location: "", minutes: 60, state: "booked", entry_id: 1, note_page_id: null },
      { key: "b", source: "ics:a", title: "Kundentermin", start: at(11), end: at(11, 30), all_day: false, location: "", minutes: 30, state: "open", entry_id: null, note_page_id: null },
    ],
    focus: { minutes: 35, sessions: [{ id: 1, reference: "NP-8801/1020", goal: "Konzept", started_at: at(9), worked_minutes: 25, status: "done", entry_id: 1 }, { id: 2, reference: "", goal: "", started_at: at(14), worked_minutes: 10, status: "aborted", entry_id: null }] },
    files: [{ name: "skizze.png", kind: "Bild", at: at(15) }],
    ...patch,
  };
}

describe("review block", () => {
  it("sums the day up compactly, without tasks or a link to the note itself", () => {
    const md = reviewMarkdown(review());
    expect(md.startsWith(`${REVIEW_OPEN}\n\n## Rückblick\n\n`)).toBe(true);
    expect(md.endsWith(REVIEW_CLOSE)).toBe(true);
    expect(md).toContain("**Zeit:** 6,5 h von 8 h gebucht, 1,5 h fehlen");
    expect(md).toContain("- NP-8801/1020 Schnittstellen: 5 h\n- NP-8801 Integration: 1,5 h");
    expect(md).toContain("**Lücken:** 10:30–13:00");
    expect(md).toContain("**Termine:** Jour fixe 09:00 (gebucht) · Kundentermin 11:00 (nicht gebucht)");
    expect(md).toContain("**Seiten:** [[Konzept Portal]] (neu) · Alt x");
    expect(md).not.toContain("[[24.09.2026]]");
    expect(md).toContain("**Aufgaben:** 1 erledigt (Angebot schreiben) · 1 neu · 1 überfällig");
    expect(md).toContain("**Fokus:** 2 Sitzungen, 0:35 h");
    expect(md).toContain("**Dateien:** skizze.png");
    // No checkbox: the review must not add tasks to the daily note.
    expect(md).not.toMatch(/\[[ x]\]/);
    expect(md).not.toContain("Zusammenfassung");
  });

  it("an empty day and a day off", () => {
    const empty = review({
      pages: [],
      meetings: [],
      files: [],
      focus: { minutes: 0, sessions: [] },
      tasks: { done: [], added: [], due: [], overdue: [], done_total: 0, added_total: 0, due_total: 0, overdue_total: 0 },
      time: { target_minutes: 0, workday: false, booked_minutes: 0, running_minutes: 0, missing_minutes: 0, items: [], entries: [], gaps: [] },
    });
    expect(reviewMarkdown(empty)).toBe(`${REVIEW_OPEN}\n\n## Rückblick\n\n**Zeit:** 0 h gebucht\n\n${REVIEW_CLOSE}`);
    expect(progress(empty)).toBe(0);
    expect(progress(review())).toBeCloseTo(390 / 480);
  });

  it("takes the summary with checkboxes and headings made harmless", () => {
    const s = "Heute ging es um das Portal.\r\n\n\n### Offen\n**Offen für morgen:**\n- [ ] Kundentermin buchen\n- [x] Nichts";
    expect(cleanSummary(s)).toBe("Heute ging es um das Portal.\n\n**Offen**\n**Offen für morgen:**\n- Kundentermin buchen\n- Nichts");
    const md = reviewMarkdown(review(), s);
    expect(md).toContain("**Zusammenfassung**\n\nHeute ging es um das Portal.");
    expect(md).toContain("- Nichts\n\n<!-- /rückblick -->");
  });

  it("is appended once and replaced on the next write", () => {
    const note = "## Fokus\n\n- [ ] Plan\n\n## Notizen\n\nText\n";
    const first = upsertReviewBlock(note, reviewMarkdown(review()));
    expect(first.startsWith(`${note}\n${REVIEW_OPEN}`)).toBe(true);
    expect(first.endsWith(`${REVIEW_CLOSE}\n`)).toBe(true);
    // Twice with other numbers: one block, the new one.
    const later = reviewMarkdown(review({ files: [] }), "Kurz.");
    const second = upsertReviewBlock(first, later);
    expect(second.split(REVIEW_OPEN).length).toBe(2);
    expect(second).not.toContain("skizze.png");
    expect(second).toContain("Kurz.");
    expect(upsertReviewBlock(second, later)).toBe(second);
    expect(second.startsWith(note)).toBe(true);
  });

  it("keeps what follows the block and what the user wrote around it", () => {
    const block = reviewMarkdown(review());
    const note = `Oben\n\n${REVIEW_OPEN}\n\nalt\n\n${REVIEW_CLOSE}\n\n## Später\n\nNoch was`;
    const out = upsertReviewBlock(note, block);
    expect(out).toBe(`Oben\n\n${block}\n\n## Später\n\nNoch was`);
    expect(findReviewBlock(out)).not.toBeNull();
    // A marker without its end is not a block: appended instead.
    const broken = `Text\n\n${REVIEW_OPEN}\n\nrest`;
    expect(findReviewBlock(broken)).toBeNull();
    expect(upsertReviewBlock(broken, block).endsWith(`${block}\n`)).toBe(true);
    // An empty note gets just the block.
    expect(upsertReviewBlock("  \n", block)).toBe(`${block}\n`);
  });
});

describe("helpers", () => {
  it("formats hours and moves days", () => {
    expect(hours(390)).toBe("6,5 h");
    expect(hours(20)).toBe("0,33 h");
    expect(hm(65)).toBe("1:05 h");
    expect(shiftDay("2026-03-29", 1)).toBe("2026-03-30");
    expect(shiftDay("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("only providers marked local and switched on write the summary", () => {
    const p = (id: string, local: boolean, enabled = true) => ({ id, local, enabled }) as AiProvider;
    expect(localProviders([p("cloud", false), p("ollama", true), p("off", true, false)]).map((x) => x.id)).toEqual(["ollama"]);
    expect(localProviders(undefined)).toEqual([]);
  });
});
