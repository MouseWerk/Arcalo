# q112 A9: app-wide design pass

Method: tour script (scratchpad/a9/tour.mjs) through the real app under Xvfb :440 — start page, page/editor,
tree context menu, palette, Aufgaben, Zeiterfassung, Kalender, Projekte, Issues (fake Jira), Graph,
Aktivität (timeline), Briefing, Tagesrückblick, Settings (Darstellung, Zeiterfassung, KI, Kalender, Über),
assistant panel, Canvas, Papierkorb, new page, split pane — in DE dark 1440x900, DE light 1440x900,
EN contrast-dark 1440x900, DE light 1100x800, EN dark 1100x800, with per-view metrics (title box/type,
header bar, horizontal overflow). Static audit of ui/src/styles (scratchpad/a9/audit.py, raw.py).
Shots: q112-shots/design/ (sheet-before-*/sheet-after-* contact sheets, cmp-* before/after pairs,
raw/<phase>-<lang>-<theme>-<width>/<view>.png).

Overall: the app was already close (shared .btn/.input/.segmented/.menu/.empty components, color tokens,
forced-colors and reduced-motion handled). The divergence was in the non-color values and a few views.

## Audit: one-off values (before -> after, outside tokens.css)
| kind | before | after | note |
|---|---|---|---|
| font-size raw px | 42 | 17 | left: first-run illustrations, presentation timer, canvas zoomed-out label, lock PIN, print |
| font-weight numbers (400/500/550/600/650/680/700/750) | 389 | 22 | 550 -> medium, 680/700/750 -> one heading weight 650; left: first-run scenes, logo |
| border-radius raw px | 183 | 24 | 3/5/7/9/10/11/13/14/16 px -> scale; half-height radii -> --r-pill; left: chat bubbles' asymmetric corners, logo |
| z-index >= 10 raw (15 distinct values 20…1000) | 30 | 0 | named layers --z-inline … --z-top, same order |
| focus outline literal | 48 | 0 | --focus-ring; text-field halo --focus-halo (19) |
| uppercase label tracking (0.02–0.06em, 2xs/xs, 600/650) | 44 | 18 | 27 section labels -> fs-xs / semibold / --ls-eyebrow; left: badges, callouts, slides |
| durations | 54 | 47 | spinner/pulse loops tokenized; left: choreographed first-run and presentation scenes (intentional) |

Control heights were already 22/26/30/32 in the shared components; now named (--ctl-xs/sm/md/lg).
Icons: Lucide default stroke 2 (bare icons, Button icons) vs 1.75 (IconButton) mixed in one toolbar.

## Findings (severity, view, root cause, fix, test)
1. MEDIUM narrow split pane: stat tiles (Zeiterfassung) wrapped „41,50 / h“, two columns at ~200 px.
   Root: 2-column rule down to 0 px, value could wrap. Fix: nowrap + tabular numbers, one column under
   440 px for .rv-stats, .activity-stats. Integration: the four short Zeiterfassung tiles (.stat-row) stay
   two by two there (half the height), with tighter tiles and a value size that follows the pane width
   (clamp to --fs-lg). Tests: e2e 240 (split pane at 1100 px), e2e 51 (2x2, one line, inside the tile).
2. MEDIUM three stat-tile type systems (Zeiterfassung 22 px/label 12 px text-3, Briefing/Rückblick 20 px/
   11 px medium text-2, Aktivität 20 px). Fix: one value size (--fs-stat), one label style.
3. MEDIUM tool views diverged: Kalender header 14/20 padding, title 20 px; Graph toolbar 48 px min,
   8/14/18 padding, title 15 px. Fix: --toolhead-h 52 px, same padding, same title size (narrow panes
   too). Test: e2e 240.
4. LOW Tagesrückblick date navigation was a bordered box; Zeiterfassung and Kalender use plain
   ‹ label › groups. Fix: same plain group.
5. LOW empty Canvas: bare 28 px icon and gray title; every other empty state uses the boxed 20 px icon and
   text-colored title. Fix: same markup/classes (.empty-icon), classes kept for tests.
6. LOW title weights: page titles 700, view titles 650, first-run 680, odd 550/750. Fix: --fw-heading.
7. LOW uppercase section labels in 27 places with 4 sizes/weights/trackings (sidebar, palette, panels,
   Rückblick groups, chat history, bookmark import, issue detail, graph panel, start page). Fix: one style.
8. LOW icon stroke: Lucide default 2 next to 1.75 icon buttons. Fix: --icon-stroke applied to icons at
   the default weight (explicit bolder icons such as checkmarks keep theirs).
9. LOW tables ignored density (fixed 9 px / 8 px cell padding) while tree, palette and entry rows follow
   it; Projekte's Vorgänge table was 1 px shorter than other tables. Fix: rows from --entry-row-h.
10. LOW radii: 17 distinct px values (pills written as 7/9/10/11/13/14/999 px). Fix: scale + --r-pill.
11. LOW motion: toast 260 ms, one-offs 160/180 ms, 0.3s ease. Fix: --dur/--dur-slow with --ease-out.
12. LOW layering: 15 raw z-index values across 6 files. Fix: named layers in tokens.css (order kept).

Checked, no change: view titles share position (y = 62 px under the tab bar) and type across Aufgaben,
Zeiterfassung, Projekte, Issues, Aktivität, Briefing, Rückblick, Papierkorb, Settings; header bar 38 px
everywhere; dialogs/menus/palette/toasts consistent; focus rings visible (e2e 240); contrast-dark theme
keeps its own accent; forced-colors rules (a11y.css) untouched; reduced motion still global.

## Left as is (report)
- Zeiterfassung shows two primary buttons (+ Eintrag in the header, Starten in the timer card); both are
  the main action of their area, the time agent owns the view.
- Projekte table scrolls sideways in narrow panes (836 px min, noted by A7).
- Home dashboard charts use the solid accent for bars (data color, not an action).
- Choreographed first-run animations keep their own durations and sizes.
