# X account: setup and posting with approval

Arcalo's X account posts from a queue in this repository. Every single post waits for the owner's
"Approve" in GitHub (web or the GitHub mobile app); nothing goes out without it.

## How it works

1. **Queue.** Each post is a file `docs/marketing/x-queue/<YYYY-MM-DD>-<slug>.md`:

   ```markdown
   ---
   text: |
     The post as it appears on X, line breaks kept.

     https://arcalo.mousewerk.de
   image: docs/marketing/x-assets/thumb-1-launch.png
   reply_to: 1850000000000000001
   ---

   Notes (not posted): where the claims come from, ideas for the image.
   ```

   `text` is required; `image` (a png, jpg, gif or webp in the repository, at most 5 MB) and `reply_to` (a post
   ID or post URL, for a thread) are optional. Any other key is refused, so a typo never posts something
   unintended. The text may have at most 280 characters, every link counting as 23 (X's rule). The date in the
   file name is the earliest day the post goes out; the queue posts the oldest due file first.
2. **Run.** `.github/workflows/x-post.yml` runs every day at 09:05 Berlin time, on each push to `main` that
   touches the queue, and by hand (Actions → X post → Run workflow). Each run offers at most one post.
3. **Preview.** The first job ("Preview") picks the oldest due file that is not in `posted.json` and writes the
   exact text, its length and the image into the run's summary.
4. **Approval.** The second job ("Post to X") uses the environment `x-approval`. GitHub stops it there and sends
   the owner a notification. Open the run, read the summary, then "Review deployments" → tick `x-approval` →
   "Approve and deploy" (or "Reject").
5. **Post.** After the approval the job uploads the image, creates the post and commits the post's ID and URL to
   `docs/marketing/x-queue/posted.json` (author: the owner). A file in `posted.json` is never offered again.
   If the file was changed between preview and approval, nothing is posted and the next run shows the new version.

What happens when the post is not approved:

- **Rejected:** nothing is posted and the file stays queued, so the next day's run offers it again. To drop a
  post for good, delete its file; to postpone it, rename it to a later date.
- **Not answered:** while a run waits, the next runs wait behind it (one run at a time), so two runs never offer
  the same post and missed days do not pile up into several posts. GitHub lets an approval wait up to 30 days;
  after that the run fails, nothing is posted and the file stays queued.
- **X refuses the post** (keys, credits, duplicate text): the run fails with X's message, nothing is recorded,
  and the next run offers the same file again.

## X API: plan and cost

Checked against docs.x.com on 2026-10-27; prices change, the Developer Console shows the current ones.

- New developer accounts get **pay-per-use**: you buy credits in advance in the Developer Console, with no
  subscription and no minimum spend in the docs (the console reportedly asks for at least $5 per purchase).
  The old Free, Basic ($200/month) and Pro plans are closed to new sign-ups; nothing in the docs offers free
  posting.
- **Creating a post costs $0.015; a post containing a URL costs $0.20.** Image uploads are not listed as a
  separate charge. Six posts with a link are about $1.20; one post a day with a link about $6 a month, without a
  link under $0.50. Set a spending limit per billing cycle in the console (for example $10): when it is reached,
  X blocks requests instead of charging more.
- Rate limits (far above one post a day): create post 100 per 15 minutes per user and 10,000 per 24 hours per
  app; media upload 500 per 15 minutes per user.
- Endpoints used: `POST https://api.x.com/2/media/upload` (multipart, `media_category=tweet_image`; the old v1.1
  upload on upload.twitter.com is retired) and `POST https://api.x.com/2/tweets`, both with OAuth 1.0a user
  context (the account's own access token and secret), signed in `scripts/x-post.mjs`.

## Owner's steps

### 1. Create the X account

Create it on x.com with its own e-mail address (for example a new address under mousewerk.de) and your phone for
verification. Handle suggestions, in this order: `@arcaloapp`, `@arcalo_app`, `@getarcalo`, `@arcalohq`
(`@arcalo` if it is free). Availability could not be checked from here (x.com does not answer automated
requests); the sign-up form shows it.

Fill in the profile from `docs/marketing/x-assets/draft.md`: name `Arcalo`, bio, location `Germany`, website
`https://arcalo.mousewerk.de`, profile picture `x-assets/avatar-400.png`, header `x-assets/banner-1500x500.png`.
Optionally mark it as an automated account (Settings → Your account → Account information → Automation, managed
by your personal account).

### 2. Developer access and keys

1. Signed in as the **new Arcalo account**, open developer.x.com and sign up for developer access (pay-per-use).
   Describe the use honestly, e.g. "Post announcements for the open-source app Arcalo from our repository; every
   post is approved by hand."
2. Buy a small amount of credits (e.g. $5) and set a spending limit.
3. Create a project and an app in it.
4. In the app: User authentication settings → Set up → App permissions **Read and write**, type of app "Web
   App, Automated App or Bot", callback URL and website `https://arcalo.mousewerk.de` (not used, but required).
   Save.
5. Keys and tokens: generate or regenerate the **API Key and Secret** (consumer keys), then under
   "Access Token and Secret" press Generate. It must say "Created with Read and Write permissions"; a token made
   before step 4 is read-only, so regenerate it.
6. Keep the four values for the next step only; do not store them anywhere else.

### 3. GitHub environment with the approval

In MouseWerk/Arcalo: Settings → Environments → New environment → name `x-approval` → Configure:

- **Required reviewers:** add yourself. Leave "Prevent self-review" **off**, because your own pushes start runs.
- **Deployment branches and tags:** "Selected branches and tags" → add `main`.
- **Environment secrets:** add `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_SECRET` (API Key, API
  Key Secret, Access Token, Access Token Secret).

The secrets live only in this environment, so only the approved job can read them.

### 4. Approve from the phone

Install GitHub Mobile and sign in. Profile → Settings (gear) → Notifications: allow push notifications and turn on
**Deployment reviews**. Each waiting post then arrives as a notification; open it, read the run summary, and tap
"Review deployments" → Approve. On the web the same notification is in your GitHub inbox and by e-mail.

Test once: Actions → X post → Run workflow on `main`. If a post is due, the summary shows it and the approval is
requested.

### 5. Adding posts

- Add a file to `docs/marketing/x-queue/` as described above and push it to `main` (the push offers the oldest
  due post right away; the rest go one per day).
- Or ask the coding assistant: "Draft three X posts about <topic> for the queue". Rules for drafts: English, honest claims
  only (backed by the README or release notes, noted in the body), at most one or two hashtags, 280 characters.
- Check a file before pushing: `node scripts/x-post.mjs preview <file>` and
  `node scripts/x-post.mjs post <file> --dry-run` (prints the requests, sends nothing, needs no keys). CI also
  checks every queued file.

### 6. Safety

- The keys exist only as environment secrets in GitHub; the script reads them from the environment and the dry
  run redacts tokens. Never put them into a file.
- Nothing is posted without your approval, and what you approve is exactly what the summary shows (the post job
  refuses a file that changed after the preview).
- To stop posting: Actions → X post → "..." → **Disable workflow**. To stop it completely, also delete the
  secrets or revoke the tokens in the Developer Console (Keys and tokens → Revoke).
- A wrong post: delete it on x.com; its entry in `posted.json` keeps it from being posted again.
