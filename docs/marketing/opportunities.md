# Marketing opportunities

Tracker for places to present Arcalo. Updated by the weekly marketing scout routine. Last full check:
2026-10-27 (release 1.22.0). Launch order and timing: [launch-1.22.md](launch-1.22.md). Drafts:
[drafts/](drafts/).

Rules:

- Act automatically only on own channels (website, GitHub releases/README, own social accounts once tokens exist).
- Anything on third-party sites (directories, lists, forums) is prepared here and done only after approval:
  submit, open a PR, or post by hand.
- No fake accounts, no follow bots, no mass DMs, no unsolicited replies, no repeated posts of the same link.
- Forum posts (Reddit, Hacker News, Product Hunt) are drafts for a person to post, never automated.
- Respect each community's self-promotion rules. Where self-promotion is not allowed, the channel is
  `rejected` with the reason, and nothing is posted there.
- Drafts prepared with AI help are marked; where a channel requires disclosure (dev.to) or refuses AI-written
  text (This Week in Rust, SAP Community), the owner rewrites or discloses.

Status: `idea` -> `checked` (rules read, fits) -> `drafted` -> `approved` -> `done` / `rejected`.

Facts at the last check: repository created 2026-09-23, 1 star, about 180 installer downloads over the listed
releases, no GitHub description or topics set, not on Hacker News, Product Hunt, AlternativeTo, OpenAlternative
or winget yet.

## Directories, catalogs and lists

| Where | Type | Rules / cost (checked 2026-10-27) | Status | Next step | Draft |
| --- | --- | --- | --- | --- | --- |
| GitHub description and topics | Own repo | Free; the session proxy cannot set them | drafted | Owner pastes them (launch plan) | [launch-1.22.md](launch-1.22.md#owner-only-actions) |
| [winget-pkgs](https://github.com/microsoft/winget-pkgs) | Package manager | Not listed; manifests schema 1.12.0; first PR by hand, CLA, review days to two weeks | drafted | Owner validates on Windows and submits 1.22.0 | [drafts/winget.md](drafts/winget.md), [winget/](winget/) |
| [AlternativeTo](https://alternativeto.net/software/obsidian/) | Directory | Not listed; free account, "Suggest new application", slow free queue, optional paid priority review | drafted | Owner account, submit | [drafts/alternativeto.md](drafts/alternativeto.md) |
| [OpenAlternative](https://openalternative.co/) | Directory | Not listed; submit with sign-in; listing packages decide speed and placement (free option to confirm) | drafted | Owner submits after GitHub topics are set | [drafts/openalternative.md](drafts/openalternative.md) |
| [SaaSHub](https://www.saashub.com/) | Directory | Free listing, manual approval; paid "featured" only | drafted | Owner submits | [drafts/directories-other.md](drafts/directories-other.md) |
| [heise Download](https://www.heise.de/download/) | German download site | Free developer account, "Programm hochladen"; no right to a listing | drafted | Owner account, upload entry | [drafts/directories-other.md](drafts/directories-other.md) |
| Softpedia | Download site | Site blocks automated reading; developer form historically at /user/submit.shtml | checked (not verified) | Owner checks the form; low priority | [drafts/directories-other.md](drafts/directories-other.md) |
| Slant | Q&A directory | Site blocks automated reading; activity not confirmed | checked (not verified) | Skip unless a fitting active question exists | [drafts/directories-other.md](drafts/directories-other.md) |
| CHIP Download | German download site | No submission route found; downloads reported to go through CHIP's own setup manager | `rejected` | None | [drafts/directories-other.md](drafts/directories-other.md) |
| [wingetly.io](https://wingetly.io/tags/local-first) | winget catalog | Picks up winget packages by itself | checked | Wait for the winget merge | |
| [selfhostyourself.com](https://selfhostyourself.com/alternative-to/obsidian) | Directory | Self-hosted software; Arcalo is a desktop app | `rejected` | None | |
| [tehtbl/awesome-note-taking](https://github.com/tehtbl/awesome-note-taking) | Awesome list | Open; has a Tauri section; format with icons, license, stack | drafted | Owner opens the PR | [drafts/awesome-lists.md](drafts/awesome-lists.md) |
| [brettkromkamp/awesome-knowledge-management](https://github.com/brettkromkamp/awesome-knowledge-management) | Awesome list | Open; first-hand experience; add at the bottom of the category | drafted | Owner opens the PR | [drafts/awesome-lists.md](drafts/awesome-lists.md) |
| [mundimark/awesome-markdown-editors](https://github.com/mundimark/awesome-markdown-editors) | Awesome list | Open; 2026 entries go to UPCOMING.md first | drafted | Owner opens the PR | [drafts/awesome-lists.md](drafts/awesome-lists.md) |
| [pluja/awesome-privacy](https://github.com/pluja/awesome-privacy) | Awesome list | Open; privacy policy, no tracking on the website (checked: none) | drafted | Owner opens the PR | [drafts/awesome-lists.md](drafts/awesome-lists.md) |
| [ever-co/awesome-time-tracking](https://github.com/ever-co/awesome-time-tracking) | Generated list | No contribution route stated; generated with a directory platform | checked | Owner asks in an issue first; low priority | [drafts/awesome-lists.md](drafts/awesome-lists.md) |
| [awesome-tauri](https://github.com/tauri-apps/awesome-tauri) | Awesome list | "Application submissions are not accepted anymore" | `rejected` | None | |
| [awesome-rust](https://github.com/rust-unofficial/awesome-rust) | Awesome list | Needs more than 50 stars or 2,000 crates.io downloads | `rejected` (for now) | Revisit at 50 stars; entry line is ready | [drafts/awesome-lists.md](drafts/awesome-lists.md) |
| [awesome-local-first](https://github.com/alexanderop/awesome-local-first) | Awesome list | "Contributions are closed" | `rejected` | None | |
| Awesome Obsidian-alternatives list | Awesome list | None maintained found; awesome-note-taking covers it | `rejected` | None | |

## Communities (drafts only, posted by the owner)

| Where | Angle | Rules (checked 2026-10-27) | Status | Next step | Draft |
| --- | --- | --- | --- | --- | --- |
| Hacker News "Show HN" | Local-first workday app, Rust + Tauri | Must be tryable without sign-up, maker present, no vote requests; first Show HN for Arcalo | drafted | Owner posts Tue 3 Nov 2026, 8:30 ET | [drafts/show-hn.md](drafts/show-hn.md) |
| Product Hunt | Launch with gallery | Personal account at least about a week old; tagline 60, description 260; no upvote requests | drafted | Owner creates the account now, schedules Tue 17 Nov 2026 | [drafts/product-hunt.md](drafts/product-hunt.md) |
| Lobsters | Rust/Tauri article | Invite only; new users (70 days) may not submit self-promo or use the "show" tag; self-promo under a quarter of activity | `rejected` | Only if the owner is invited and active there for months | |
| r/rust | Technical article | Self-promo bar met by open source under an OSI license or a post about your Rust experience | drafted | Owner posts the article link Tue 10 Nov 2026 | [drafts/reddit.md](drafts/reddit.md) |
| r/SideProject | Feedback request | Sharing side projects for feedback is the sub's purpose | drafted | Owner posts Thu 12 Nov 2026 | [drafts/reddit.md](drafts/reddit.md) |
| r/de_EDV | German feedback request | No clear written rule | drafted | Owner sends the modmail first | [drafts/reddit.md](drafts/reddit.md) |
| r/SAP | CATS export | No clear written rule | drafted (modmail) | Owner asks the mods first | [drafts/reddit.md](drafts/reddit.md) |
| r/jira | Jira issue window | No clear written rule | drafted (modmail) | Owner asks the mods first | [drafts/reddit.md](drafts/reddit.md) |
| r/productivity | | "No Advertising": no self-promotion in any form | `rejected` | None | |
| r/opensource | | Since 2026-10-24: no projects that use or are intended for AI; a year of maintenance, several contributors, a community | `rejected` | Revisit only if the rules change | |
| r/ObsidianMD | | "Don't shill"; promotion must support or integrate with Obsidian | `rejected` | Answer only where someone asks for exactly this, with disclosure | |
| r/selfhosted | | Self-hosted server software; desktop apps do not fit | `rejected` | None | |
| Obsidian forum "Share & showcase" | | For plugins, themes, snippets, workflows; code of conduct: promotion must be relevant to Obsidian, not separate projects | `rejected` | None | |
| Atlassian Community | | Not a place for marketing; partner posts must help users, links to outside sites not allowed | `rejected` | Answer a fitting question only with disclosure, no links | |
| SAP Community blog | CATS file format how-to | Must be about SAP; no external links to market products; one blog in moderation at a time; generative-AI guidelines | drafted (needs owner rewrite) | Owner rewrites in his words, publishes EN first | [drafts/sap-community-blog.md](drafts/sap-community-blog.md) |
| dev.to | "Building a local-first workday app with Rust and Tauri" | Not mainly promotional; AI assistance must be disclosed | drafted | Owner publishes Thu 5 Nov 2026 | [drafts/devto-hashnode-article.md](drafts/devto-hashnode-article.md) |
| Hashnode | Cross-post | Free blogging still works; set canonical URL to dev.to | drafted | Owner cross-posts after dev.to | [drafts/devto-hashnode-article.md](drafts/devto-hashnode-article.md) |

## Newsletters and press

| Where | Rules (checked 2026-10-27) | Status | Next step | Draft |
| --- | --- | --- | --- | --- |
| Changelog News | Form after sign-in; own work welcome; no tutorials or commercial products | drafted | Owner submits after Show HN | [drafts/newsletters.md](drafts/newsletters.md) |
| This Week in Rust | No project announcements by PR; articles by PR; no LLM-written articles | checked | Only with an owner-written article | [drafts/newsletters.md](drafts/newsletters.md) |
| Console.dev | Tools whose primary user is a developer | `rejected` | None | |
| Tauri showcase | No showcase on tauri.app; awesome-tauri closed to apps; Discord channel unverified | checked | Owner checks the Discord showcase channel rules | [drafts/newsletters.md](drafts/newsletters.md) |
| t3n | Themenvorschläge an redaktion@t3n.de | drafted | Owner e-mails after Product Hunt | [drafts/press-de.md](drafts/press-de.md) |
| ComputerBase | News-Tipp form or redaktion@; press releases to presse@ | drafted | Owner e-mails after Product Hunt | [drafts/press-de.md](drafts/press-de.md) |
| Golem.de | Contact address not readable from here | drafted | Owner checks the Impressum, then e-mails | [drafts/press-de.md](drafts/press-de.md) |
| heise (editorial) | Contact forms; an app release is rarely a story alone | checked | Only after traction | [drafts/press-de.md](drafts/press-de.md) |

## Own channels

| Channel | Status | Next step | Draft |
| --- | --- | --- | --- |
| LinkedIn (owner's profile) | drafted, 3 German variants | Owner posts variant 2 on Wed 28 Oct 2026 | [drafts/linkedin-xing-de.md](drafts/linkedin-xing-de.md) |
| XING (owner's profile) | drafted | Owner posts with variant 1 | [drafts/linkedin-xing-de.md](drafts/linkedin-xing-de.md) |
| X | Assets in `x-assets/`, waiting for working tokens | Owner fixes the tokens | [x-assets/draft.md](x-assets/draft.md) |
| Bluesky | drafted; no account yet | Owner creates the `arcalo.mousewerk.de` handle | [drafts/bluesky-mastodon.md](drafts/bluesky-mastodon.md) |
| Mastodon | drafted; no account yet | Owner picks an instance, reads its rules | [drafts/bluesky-mastodon.md](drafts/bluesky-mastodon.md) |
| Website changelog per release | Covered by the release process | | |
