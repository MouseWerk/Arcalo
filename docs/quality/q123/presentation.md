# Presentation findings, q123

Owner's report: "in der Präsentations Ansicht gibt es noch sehr viele Bugs auch mit Bildern usw". Audit of
`ui/src/components/Presentation.tsx`, `ui/src/lib/slides.ts`, the slide styles in `ui/src/styles/app.css` and
`src-tauri/src/present.rs`. Each problem was reproduced first with `e2e/tests/420-present-slides.test.js`
against the unchanged app (all eight tests failed there), then fixed at the cause. Screenshots of every slide
type in Arcalo Hell, Arcalo Dunkel and high contrast (normal and Beamer, presenter overlay, presenter window)
are written by that test as `420-*.png`.

| Id | Area | Status |
|---|---|---|
| P1 | Images with a width were squeezed | fixed |
| P2 | Markdown images (`![x](attachments/…)`) broken | fixed |
| P3 | Several images in one paragraph stacked | fixed |
| P4 | An image alone on its slide stayed small | fixed |
| P5 | Missing images and empty drawings showed a broken picture | fixed |
| P6 | Long code lines cut off at the slide edge | fixed |
| P7 | Mermaid diagrams tiny | fixed |
| P8 | Mermaid diagrams dark on the white Beamer slide | fixed |
| P9 | Keys typed into the note underneath; Tab left the presentation | fixed |
| P10 | Focus lost after the end | fixed |
| P11 | Slides did not follow changes of the note | fixed |
| P12 | Notes with one title and `##` sections were one tiny slide | fixed |
| P13 | Reload during a presentation left the window full screen | fixed |
| P14 | Presenter window ignored the chosen theme | fixed |
| P15 | Controls covered the counter in narrow windows | fixed |
| P16 | Screen readers announced the timer every second | fixed |
| P17 | Presenter window title always German | fixed |
| P18 | Slide styles lost to the editor's (headings, code, tables, callouts) | fixed |
| P19 | Long lists shrank to unreadable text | fixed |
| P20 | Note title in the control bar wrapped at 900 px | fixed |

## P1 Images with a width were squeezed

- Symptom: `![[hochkant.png|720]]` on a slide was drawn 1066 x 592 px instead of its 600 x 2000 aspect.
- Cause: the slide set `width: 1152px` and the stylesheet `max-height: 640px`; with both fixed the image is
  stretched.
- Fix: the width is kept as `data-width` and applied in `SlideView.fit`, capped to what the height limit
  allows for the image's aspect (`max-height * naturalWidth / naturalHeight`); `width/height: auto` otherwise.
- Test: 420 "images of every size and aspect …" checks every image's shown aspect against its natural one,
  also at 900 and 1920 px.

## P2 Markdown images broken

- Symptom: `![Diagramm](attachments/bild.png)` (also written by the editor for pasted Markdown) showed nothing
  (naturalWidth 0).
- Cause: the slide renderer passed the relative address through; the editor resolves it with `attachmentUrl`,
  the slides did not. Such images also never refitted the slide after loading.
- Fix: `slideHtml` resolves local image addresses on an inert `<template>` (no request to the wrong address),
  and every image on a slide goes through `hydrateImage` (refit on load, notice on error).
- Test: 420, slide 4.

## P3 Several images in one paragraph stacked

- Symptom: `![[a.png|240]] ![[b.png|240]]` showed the images below each other (the editor shows them side by side).
- Cause: `.slide-img` is `display: block`.
- Fix: paragraphs that hold only images get `slide-media` (flex row, centered, wrapping).
- Test: 420 asserts both images on the same line.

## P4 An image alone on its slide stayed small

- Symptom: a portrait image alone on a slide used 640 of ~740 design pixels; on a 4:3 or tall window much less.
- Fix: a slide of only images (`slide-media-only`) lets them use the slide's inner height (`--slide-h`, set in
  `fit`).
- Test: 420 asserts the image is over 70 % of the window height.

## P5 Missing images and empty drawings

- Symptom: a freshly created drawing (no SVG preview yet) or a deleted attachment showed the browser's broken
  image.
- Fix: on `error` the image is replaced by a quiet chip "Bild fehlt: name" / "Image missing: name"
  (`present.imageMissing`).
- Test: 420, slide 11.

## P6 Long code lines cut off

- Symptom: a 220 character line ended at the slide edge (`pre` 3317 px inside 1378 px).
- Cause: `pre { white-space: pre; overflow: hidden }`; the hidden overflow also kept the fit from seeing the
  width, so the slide was not scaled either.
- Fix: code on slides wraps (`pre-wrap`, `overflow-wrap: anywhere`, `overflow: visible`), like a slide has no
  scroll bar. The first CI run showed the rule had no effect: see P18.
- Test: 420 checks that no element on any slide clips its content or sticks out of the slide.

## P7 Mermaid diagrams tiny

- Symptom: a small flowchart was 225 px wide on a 1600 px slide.
- Cause: Mermaid writes `max-width: <natural>px` on the SVG.
- Fix: the SVG is enlarged by the same factor as images (1.6), never wider than the slide.
- Test: 420 asserts the diagram is wider than 400 design pixels.

## P8 Mermaid diagrams dark on the white Beamer slide

- Symptom: in a dark theme with "Beamer" on, diagrams kept light labels on dark boxes on a white slide.
- Cause: diagrams were always drawn in the app theme.
- Fix: `SlideView` takes `light` (Beamer); the content is keyed by it, so diagrams are drawn again in the light
  theme when Beamer is switched.
- Test: 420 "the white Beamer slide draws diagrams light …" (Arcalo Dunkel and high contrast dark).

## P9 Keys typed into the note; Tab left the presentation

- Symptom: while presenting, letters and Delete reached the editor under the slides (the handler stopped the
  event's propagation but not its default action, and the editor kept the focus); Tab moved into the app.
- Fix: the presentation is a focusable dialog that takes the focus, keeps it (focus that wanders outside, e.g.
  from a closing palette, comes back) and prevents every key it does not handle; Tab cycles through its own
  buttons; Enter/Space press a focused button; a clicked button keeps no focus, so Space turns slides again.
- Test: 420 "keys never type into the note …" types a, x, Delete and Tab and compares the note.

## P10 Focus lost after the end

- Fix: the focus goes back to where it was, or into the presented note's editor when it was started from the
  palette or a menu. The scroll position of the note is kept (checked).
- Test: same test.

## P11 Slides did not follow changes of the note

- Symptom: a note changed by the capture window, a voice note, mail, the command line or Git sync kept its old
  slides until the presentation was restarted.
- Fix: the presentation reloads on `data://pages`, `data://tasks`, `capture://stored`, `data://external` and
  `gitsync://pulled` for its page and keeps the current slide (or the last one left).
- Test: 420 "the slides follow changes of the note made elsewhere".

## P12 Notes with `##` sections were one tiny slide

- Symptom: "# Bericht / ## Ziele / ## Stand / ## Ausblick" without `---` became one slide scaled down to about 35 %.
- Fix: without rules, a note with at most one `#` heading and several `##` headings is split at the `##`
  headings (`slides.ts`, `headingSplits`); notes with several `#` headings split as before.
- Test: `ui/src/lib/slides.test.ts` and 420 "a note with one title and ## sections …".

## P13 Reload during a presentation left the window full screen

- Symptom: a reload (F5 in WebView2, an update restart of the UI) left the main window full screen without
  slides and the presenter window open.
- Fix: `presentation_end` changes nothing without a running presentation, and the main window calls it on
  start; keys a presentation does not handle (F5 among them) are prevented while presenting.
- Test: 420 "a reload in the middle of a presentation leaves full screen".

## P14 Presenter window ignored the theme

- Symptom: the presenter window only set light/dark; Nord, high contrast or the accent color were missing.
- Fix: it applies the theme from the settings like the capture and search windows and follows
  `settings://changed`.
- Test: 420 "the presenter window takes the theme of the settings" (high contrast dark).

## P15 Controls covered the counter in narrow windows

- Symptom: at 900 px the control bar overlapped the slide counter and timer in the corner.
- Fix: below 1180 px the bar sits above the corner line.
- Test: 420 "at 900 and 1920 px …" checks the bar is inside the window and clear of the counter.

## P16 Timer announced every second

- Cause: `aria-live` was on the corner that holds the running timer. Now only the counter is live.

## P17 Presenter window title

- The window title "Referentenansicht – Arcalo" is now translated (`tr!`).

## P18 Slide styles lost to the editor's

- Symptom: on CI the code still did not wrap (the `pre` stayed 3317 px wide); slide headings were smaller than
  designed (2.2em), tables and callouts used the editor's sizes and padding.
- Cause: `editor.css` is imported after `app.css`; `.prose pre`, `.prose h1`, `.prose table`,
  `.prose blockquote.callout` … have the same weight as `.slide-content pre` and so on, and won.
- Fix: every slide rule is written as `.slide-content.prose …` (one class more). The editor's callout icon,
  sized in px, is now sized with the slide text and level with the callout title.
- Test: 420 (the clipped-code check), and the screenshots of every slide in light, dark and high contrast.

## P19 Long lists shrank to unreadable text

- Symptom: a 40 item list was scaled to about 35 % (barely readable at 900 px).
- Fix: when a list of 10 or more items makes its slide smaller than 75 %, `fit` tries two and three columns and
  keeps the layout with the largest text.
- Test: 420 asserts the list slide's scale is above 0.55.

## P20 Title in the control bar wrapped

- Symptom: at 900 px the note title in the control bar broke over three lines.
- Fix: `white-space: nowrap` with ellipsis. Test: 420 checks a single line at 900 and 1920 px.

## Harness note

WebKit's WebDriver sends a repeated digit (`1`, `1`) as a single key press, so the tests jump to slide 11 with
End; typing 11 by hand works.

## Checked without findings

Navigation (arrows, space, PageUp/Down, Home/End, digits + Enter, click and right click, Esc), the empty note,
frontmatter, `---` in code, speaker notes, tables (scaled to fit), long lists (scaled to fit), task lists,
callouts, links (shown, not followed), opening from the page menu, the palette and the shortcut, split panes
(the active pane's page is presented).

## Not done

- Two monitors (the presenter window on a second screen) cannot run in the headless harness; the window's
  rendering is covered by loading `#presenter` in the main window.
- Tests 420, 43, 51, 52, 61 and 124 pass locally; every slide type was looked at in Arcalo Hell, Arcalo Dunkel
  and high contrast dark, normal and Beamer, the presenter overlay and window.
