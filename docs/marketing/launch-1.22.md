# Launch plan for Arcalo 1.22

Released 2026-10-27. This plan turns the 1.22 release into Arcalo's first broader launch. Every item on a
third-party site is done by the owner by hand, after his approval; channel status lives in
[opportunities.md](opportunities.md), the texts in [drafts/](drafts/).

Principle: first the places that keep working by themselves (directories, lists, winget), then one big
moment per week (Show HN, then Reddit, then Product Hunt), each on a weekday, never two on the same day, and
always with time to answer comments. Europe and the US are both on winter time from 1 November 2026, so
8:30 US Eastern is 14:30 in Germany.

## Before anything else (this week)

| # | Item | Who | Effort | Draft |
| --- | --- | --- | --- | --- |
| 1 | Set the GitHub description and topics (below) | Owner | 5 min | this file |
| 2 | Clean the v1.22.0 release page: it carries the iOS check's simulator files (`ipad-*.png`, `iphone-*.png`, `*.json`, `*.log`, `gen-apple.tar.gz`) next to the installers. Visitors from HN and Product Hunt land there. Removing release assets is the owner's call (main already stops attaching them for future releases). | Owner | 10 min | |
| 3 | Create the Product Hunt account (personal, must be about a week old before launching) | Owner | 5 min | [product-hunt.md](drafts/product-hunt.md) |
| 4 | Make two images: a screenshot of the 1.22 Jira issue window (demo data), and `thumb-1-launch.png` / `thumb-3-ai.png` again without the old name `Annalo` in the code block | Owner or a session with the app | 1-2 h | |
| 5 | Submit winget 1.22.0 (validate and test-install on Windows, CLA) | Owner | 1-2 h, then 1-14 days review | [winget.md](drafts/winget.md) |

## Week 0: Tue 27 Oct to Fri 30 Oct 2026, directories and lists

| Day | Item | Who | Effort | Draft |
| --- | --- | --- | --- | --- |
| Wed 28 Oct | LinkedIn variant 2 (Jira issues in 1.22), 8:30 | Owner | 15 min | [linkedin-xing-de.md](drafts/linkedin-xing-de.md) |
| Wed 28 Oct | AlternativeTo: suggest new application | Owner | 30 min | [alternativeto.md](drafts/alternativeto.md) |
| Wed 28 Oct | OpenAlternative (after the topics are set) | Owner | 20 min | [openalternative.md](drafts/openalternative.md) |
| Thu 29 Oct | SaaSHub and heise Download | Owner | 45 min | [directories-other.md](drafts/directories-other.md) |
| Thu 29 Oct | PRs: awesome-note-taking, awesome-knowledge-management | Owner | 30 min | [awesome-lists.md](drafts/awesome-lists.md) |
| Fri 30 Oct | PRs: awesome-markdown-editors (UPCOMING.md), awesome-privacy | Owner | 30 min | [awesome-lists.md](drafts/awesome-lists.md) |
| Fri 30 Oct | Bluesky and Mastodon accounts, 1.22 release post | Owner | 1 h | [bluesky-mastodon.md](drafts/bluesky-mastodon.md) |

## Week 1: Mon 2 Nov to Fri 6 Nov 2026, Hacker News

| Day | Item | Who | Effort | Draft |
| --- | --- | --- | --- | --- |
| Mon 2 Nov | Read the Show HN draft once more, prepare answers, block Tuesday afternoon | Owner | 30 min | [show-hn.md](drafts/show-hn.md) |
| Tue 3 Nov | **Show HN**, 8:30 ET / 14:30 CET, first comment right after; stay 3 hours | Owner | 3-4 h | [show-hn.md](drafts/show-hn.md) |
| Wed 4 Nov | Changelog News submission | Owner | 15 min | [newsletters.md](drafts/newsletters.md) |
| Thu 5 Nov | dev.to article (rewritten or with the AI-assistance line), then Hashnode cross-post with canonical URL | Owner | 1-3 h | [devto-hashnode-article.md](drafts/devto-hashnode-article.md) |
| Fri 6 Nov | Collect what HN asked; fix README gaps (a small README change is an own-channel task) | Owner / session | 1 h | |

## Week 2: Mon 9 Nov to Fri 13 Nov 2026, Reddit (staggered)

| Day | Item | Who | Effort | Draft |
| --- | --- | --- | --- | --- |
| Mon 9 Nov | Modmails to r/de_EDV, r/SAP, r/jira | Owner | 15 min | [reddit.md](drafts/reddit.md) |
| Tue 10 Nov | **r/rust** link to the article, 16:00 CET; LinkedIn variant 1 and XING, 8:30 | Owner | 2 h | [reddit.md](drafts/reddit.md), [linkedin-xing-de.md](drafts/linkedin-xing-de.md) |
| Thu 12 Nov | **r/SideProject**, 15:00 CET | Owner | 1-2 h | [reddit.md](drafts/reddit.md) |
| Fri 13 Nov | Product Hunt: fill the scheduled launch (gallery, first comment) | Owner | 1 h | [product-hunt.md](drafts/product-hunt.md) |

## Week 3: Mon 16 Nov to Fri 20 Nov 2026, Product Hunt and SAP

| Day | Item | Who | Effort | Draft |
| --- | --- | --- | --- | --- |
| Tue 17 Nov | **Product Hunt** launch, 00:01 PT / 09:01 CET; answer all day; one post on own channels | Owner | 4-6 h spread over the day | [product-hunt.md](drafts/product-hunt.md) |
| Wed 18 Nov | SAP Community blog, English, after the owner's rewrite and a check against his SAP system | Owner | 2-3 h | [sap-community-blog.md](drafts/sap-community-blog.md) |
| Thu 19 Nov | Press e-mails: t3n, ComputerBase, Golem (one each, personal) | Owner | 1 h | [press-de.md](drafts/press-de.md) |
| Thu 19 Nov | r/de_EDV, r/SAP, r/jira posts, only where the mods said yes, one per day | Owner | 30 min each | [reddit.md](drafts/reddit.md) |

## Week 4: from Mon 23 Nov 2026

| Day | Item | Who | Effort | Draft |
| --- | --- | --- | --- | --- |
| Tue 24 Nov | LinkedIn variant 3 (AI on your terms) | Owner | 15 min | [linkedin-xing-de.md](drafts/linkedin-xing-de.md) |
| After the EN blog is through | SAP Community blog in German, if it adds something | Owner | 1 h | [sap-community-blog.md](drafts/sap-community-blog.md) |
| After the winget merge | `winget install MouseWerk.Arcalo` in the README download table and on the website; set `WINGET_TOKEN` | Owner | 30 min | [winget.md](drafts/winget.md) |
| At 50 stars | awesome-rust PR | Owner | 15 min | [awesome-lists.md](drafts/awesome-lists.md) |
| Weekly | Update [opportunities.md](opportunities.md): what was posted, links, results | Scout routine | 15 min | |

Total owner time over four weeks: about 25 to 35 hours, most of it on the three launch days (HN, r/rust,
Product Hunt) answering comments.

## Measuring

Without telemetry there are only public numbers: GitHub stars, release download counts
(`gh api repos/MouseWerk/Arcalo/releases --jq '.[].assets[].download_count'`), referrers and views in the
repository's Insights → Traffic (owner only), and comments. Note them in the tracker before and one week after
each launch day. Do not add analytics to the app or the website for this.

## Owner-only actions

1. **GitHub description and topics** (the session proxy cannot set them). Settings → General, or with `gh`:

   Description (255 characters):

   ```
   Local-first desktop app for your workday: Markdown notes with [[links]], tasks, Outlook and ICS meetings, and time tracking that exports to SAP CATS and Jira. AI on your own providers or none. No account, no telemetry. Windows, macOS, Linux. Rust + Tauri.
   ```

   Website: `https://arcalo.mousewerk.de/` (already set).

   Topics (20, GitHub's maximum):

   ```
   local-first tauri rust desktop-app note-taking markdown knowledge-base obsidian-alternative time-tracking timesheet sap sap-cats jira outlook calendar tasks productivity ollama sqlite open-source
   ```

   ```sh
   gh repo edit MouseWerk/Arcalo \
     --description "Local-first desktop app for your workday: Markdown notes with [[links]], tasks, Outlook and ICS meetings, and time tracking that exports to SAP CATS and Jira. AI on your own providers or none. No account, no telemetry. Windows, macOS, Linux. Rust + Tauri." \
     --add-topic local-first,tauri,rust,desktop-app,note-taking,markdown,knowledge-base,obsidian-alternative,time-tracking,timesheet \
     --add-topic sap,sap-cats,jira,outlook,calendar,tasks,productivity,ollama,sqlite,open-source
   ```

   Also check that the social preview image (Settings → Social preview) is `docs/social-preview.png`.
2. **Accounts**: Product Hunt (now), AlternativeTo, OpenAlternative, SaaSHub, heise Download developer area,
   SAP Community, dev.to, Hashnode (optional), Bluesky, Mastodon; Reddit and Hacker News with his existing
   accounts. No accounts are created for him.
3. **Every post, submission, PR and e-mail** in this plan, from his own accounts.
4. **winget**: fork, CLA, validation and test install on Windows, the PR; later the `WINGET_TOKEN` secret.
5. **Release page cleanup** of v1.22.0 (item 2 above).
6. **Rewrites in his own words**: the SAP Community blog (required by its AI guidelines), the dev.to article
   if he does not want the AI-assistance line, and every personal sentence marked in the drafts.
7. **Decisions with cost or policy**: any paid listing (AlternativeTo priority review, OpenAlternative package,
   SaaSHub featured), a `rel="me"` link or a SaaSHub verification tag on the website, the Bluesky domain
   handle's DNS record.
