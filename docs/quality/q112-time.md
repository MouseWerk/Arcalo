# Arcalo 1.12 quality pass, A2: Time tracking (findings)

Severity: H = wrong data / wrong numbers users act on, M = wrong behavior with workaround, L = polish.

| # | Sev | Finding | Root cause | Fix | Test |
|---|-----|---------|------------|-----|------|
| 1 | H | Timesheet "Wochenübersicht": holidays, vacation/sick days flagged "unter Soll"; week target in "Woche gesamt" = daily x workdays, ignores own weekday targets, holidays, absences | `weekGaps`/stat used flat `daily_target_hours` | per-day targets from settings + absence_list (holidays, absences) | vitest cats.test |
| 2 | H | Own weekday targets (Saldo: e.g. Fr 5 h) ignored by day review, week proposal, start page proposal, open-days reminder: Friday shows 3 h missing, proposal fills it to 8 h | callers pass flat daily target into `gap_target` | `gap_target` uses the weekday's own target when set | Rust worktime test |
| 3 | H | End-of-day reminder fires on public holidays and vacation/sick days ("Heute 0 von 8 h gebucht"), ignores own weekday targets | `end_of_day_reminder` used flat target, no holidays/absences | caller passes the day's gap target | Rust desktop test |
| 4 | H | Kalender on DST days (2026-10-25, 2027-03-28): meetings, focus blocks and booked entries after 02:00 drawn one hour off (now line correct) | `layoutDay` placed by elapsed ms since midnight | wall-clock minutes | vitest (TZ Europe/Berlin) |
| 5 | M | Dragging a focus block to another day across a DST change moves it one hour | `moved()` adds days as 24 h | local date arithmetic | vitest |
| 6 | M | "Für CATS kopieren": hours rounded per cell, days do not add up (3 x 20 min = 0,99) | per-cell toFixed(2) | per-day running-total rounding (like the CATS file) | vitest |
| 7 | M | `/zeit 1h30m …`, `90mins`, `2std`, `1,5stunden` on a linked page: UI treats duration as reference (autocomplete opens, smart /zeit not offered); without reference the error says "Ungültige Dauer „Abstimmung“" | UI DURATION_RE narrower than core grammar; core took the duration as reference | one grammar in UI; core reports "Netzplan fehlt" | vitest + Rust |
| 8 | M | Time ranges (`/zeit NP-8801 9:00-10:30 …`) not understood | not supported | range token = start + duration (over midnight too) | Rust |
| 9 | M | Entry dialog duration field rejects `1h30m`, `1,5 Std`, `90 Min.` | parseDurationInput narrower than /zeit | same grammar | vitest |
| 10 | M | New entry dialog and timer default to LA "DEV", ignoring the per-Netzplan default LA (Settings) and sending DEV explicitly | hard-coded "DEV" | default from settings per Netzplan | vitest |
| 11 | L | Quick book (Timesheet): Enter twice books twice | no in-flight guard | guard | - |
| 12 | L | Booked entry in the Kalender lane opens the timesheet on the current week | openTab only | opens the entry's week | - |
| 13 | L | 2017 Reformationstag (nationwide, 500 years) missing | - | added | Rust |
| 14 | M | `/zeit` for an earlier day without @hh:mm: every entry started at 08:00 (stacked in the Kalender lane) | fixed default start | starts after that day's last booking | Rust tracking test |
| 15 | L | Settings: "Soll pro Arbeitstag" silently unused while targets per weekday are on | - | hint on the row | - |
| 16 | L | Timesheet header in a narrow pane: "Eintrag" wrapped alone | flex wrap | week nav on its own row (container query) | shots |

## Left open (reported, not changed)
- Chip and booking are not linked after booking: deleting the chip keeps the booking, editing/deleting the booking leaves the chip stale. Needs a design decision (chip click opens the entry; mark deleted entries).
- Timer has no pause (stop + start works); a timer over midnight books everything on its start day (no split).
- CATS copy/file always use decimal comma (SAP default in DE), also with English UI number format; a setting would be needed for SAP users with point notation.
- Projects Vorgang table scrolls horizontally in narrow panes (intentional sticky first column).
