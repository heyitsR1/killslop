# KillSlop

A browser extension that hides AI-generated slop on YouTube, X and LinkedIn,
and an open, evidence-backed list of it that anyone can use. The code is
GPL-3.0; the list is CC BY-SA 4.0.

Website: **[killslop.app](https://killslop.app)**. Privacy policy:
[killslop.app/privacy](https://killslop.app/privacy).

Read **[RESEARCH.md](RESEARCH.md)** before changing detection. Several
non-obvious constraints in there will silently break the product if you
"clean them up". To help, start with **[CONTRIBUTING.md](CONTRIBUTING.md)**.

---

## Install

KillSlop is on its way to the Chrome Web Store. Until it is listed, load it
from source in Chrome, Edge, Brave or any Chromium browser:

1. Download this repository (Code, then Download ZIP) and unzip it, or
   `git clone https://github.com/heyitsR1/killslop`.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Choose **Load unpacked** and pick the `extension/` folder.

There is no build step and nothing to install first.

## The idea

YouTube's "Made with AI" label is precise but sparse: most slop never carries
it. Guessing from titles and thumbnails catches more, but every false positive
is a public accusation against a real creator.

KillSlop builds on a measured fact: **slop farms label nearly every upload,
real channels label none** (RESEARCH.md section 7). Sampling
five of a channel's videos gives a channel-level verdict that is as objective
as the label itself, needs no moderator, and works on day one with an empty
community list. The community tier sits on top, and keeps measurement and
opinion apart so users choose how much opinion they want.

The other platforms get as much of this as they allow. X marks AI media on the
post itself, so KillSlop reads that mark for free and counts it per account,
though X accounts are far less clear-cut than YouTube channels (RESEARCH.md
section 15). LinkedIn marks nothing, so there KillSlop runs on your own marks
and the community list.

## How it decides

Six tiers, cheapest first. The first one that answers wins. Not every
platform has every tier.

| # | Tier | Cost | Notes |
|---|---|---|---|
| 0 | Your own override | free | Absolute. Your "not slop" click outranks the platform and the community. |
| 1 | Local cache | free | Verdicts don't expire: a disclosure never changes. A cached writing verdict says so, rather than passing for a label. |
| 2 | Channel inference | free | YouTube: at least 60% of at least 5 sampled uploads labelled hides the channel. X: at least 25% of at least 8 media posts. None on LinkedIn, which has no label to count. |
| 3 | Community list | 1 request per hash bucket | Batched, privacy-preserving, evidence-tagged (below). |
| 4 | Writing check | opt-in, off by default | X and LinkedIn only. For a post nothing else can place, the words themselves. Gated in the page, then asked by hash, so most posts cost nothing and are never sent. |
| 5 | InnerTube probe | ~1 KB per video | YouTube only. Throttled, background, once per video ever. X needs none: its label arrives with the feed. |

## Marking things yourself

On YouTube, watch pages get an **AI SLOP** button beside like/dislike, and
Shorts get one in the action bar. On X and LinkedIn every post gets one at the
end of its row of actions. Grey means you can press it. Pressed, it turns solid
red: the video or post is hidden from your feeds at once, and the confirmation
offers to hide the whole channel (the account on X, the author on LinkedIn) or
**Undo**. A red *tint* means KillSlop already treats it as slop; hovering says
why, and pressing it offers **Not slop**.

Your mark hides things **for you**, instantly. It hides nothing for anyone
else. The server keeps each vote in mind, and while the list is young a
maintainer checks every voted entry before it is served to anyone (see the
review queue below). One person cannot bury a channel. What counts as a "person" is
under Privacy.

Everything you have marked is listed on the **Your marks** page (popup, then
Your marks), each with a Remove button.

## The community list carries evidence

Each entry says *why* it is on the list:

- **`disclosure`**: another client's sampler watched this channel or X account
  cross the tier-2 threshold on the platform's own labels. Clients share this
  automatically when "Contribute reports" is on. The server re-checks the
  numbers against the same platform's threshold and records one per reporter.
  The project's crawler (below) measures YouTube channels the same way, in
  bulk.
- **`writing`**: the writing check read this account's or author's posts as
  AI-written. A model's reading of the words, not a label anyone published, so
  it ranks below `disclosure` and is counted in its own columns rather than
  added to the measurement. It comes from the project's own measurement, never
  from what happened to cross a user's feed.
- **`vote`**: people clicked "slop" or "not slop".
- **`review`**: a maintainer checked it by hand and nothing was measured.

Turning off "Include opinion votes" in the popup restricts the list to
measured entries, which cannot produce an opinion-based false positive. That
switch also drops `writing` entries, because a model can be wrong in the same
way an opinion can.

Decided accounts are exported in the clear under
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/), one file per
platform, so uBlock lists, ReVanced-style patches and researchers can consume
them without running the extension:

- <https://api.killslop.app/api/v1/export/youtube-channels.json>
- <https://api.killslop.app/api/v1/export/x-accounts.json>
- <https://api.killslop.app/api/v1/export/linkedin-authors.json>

Anyone may use and share the list, commercially too, as long as they credit
KillSlop and release what they build from it under the same licence. Only
accounts are exported: videos and posts are not, no post text ever is, and a
LinkedIn post's id is a one-way hash that would mean nothing anyway.

### The crawler

`scripts/measure-channels.mjs` fills the list without waiting for users to
stumble on every slop farm. It finds candidate channels in YouTube search on
topics where labelled slop clusters (RESEARCH.md section 6) and in public
blocklists (ATTRIBUTION.md), then samples each channel's 12 newest uploads with
the extension's own probe and classifier. Being listed somewhere proves
nothing: a candidate enters only if its own uploads carry YouTube's AI label.
A channel at 75% of at least 8 uploads is approved on the measurement; one
between that and the extension's bar (60% of at least 5) waits in the review
queue.

```bash
node scripts/measure-channels.mjs measure .crawl --lists cevval,aislist
node scripts/measure-channels.mjs sql .crawl > seed.sql
cd worker && npx wrangler d1 execute killslop --remote --file=../seed.sql
```

A run resumes where the last one stopped, and the SQL only adds new rows, so
it never overrides a review.

## The review queue

Every vote and measurement, except a crawler measurement well clear of the
bar, lands in a queue in the maintainer console at
`api.killslop.app/admin`, behind a password. For each entry the console shows how
many people reported it and how strongly. For YouTube entries it runs its own
check against YouTube: the video's AI label, or the labels on a channel's six
most recent uploads, with thumbnails. X and LinkedIn entries link to the post
or account instead. Approving an entry puts it in the **final database**;
rejecting it keeps it off the list whatever the votes say. The same console
holds the feedback inbox.

Review is a switch, not an architecture. `REVIEW_MODE` in
`worker/wrangler.toml` is `"all"` today: nothing is served until it is
approved. When the queue outgrows one person it can become `"votes"`
(channels measured by two independent reporters publish on their own; votes
still wait) or `"off"` (a net 3 votes, or 2 independent measurements,
decide). In every mode a maintainer's call wins. A channel reported under
both its `@handle` and its `UC...` id is reviewed once; the verdict is copied
to the other spelling.

## Feedback

The popup has a **Send feedback** page: a category, a message, and an
optional email for a reply. Opened from a YouTube, X or LinkedIn tab, it
offers to attach that page's link. Messages go to the console's inbox.

## Roadmap

The goal is a computer you can use without wading through AI slop, whatever
you are scrolling:

1. **YouTube**: live.
2. **X**: live. X's own AI media label, account inference and the list.
3. **LinkedIn**: live. Your marks and the list; LinkedIn exposes no AI label.
4. **Later**: Reddit, Pinterest, Google Images, Spotify.

The database is keyed by platform from the start (a `platform` column on
every entry), so a new platform is a content script and an id validator, not
a migration. CONTRIBUTING.md has the steps.

## Where the code lives

```
extension/
  src/core/          policy: classification, cache, community client, settings, ids
  src/background/    message router; owns storage and the community list
  src/content/       one adapter per site: youtube.js (with the probe queue,
                     below); x.js and linkedin.js on the shared feed.js;
                     x-page.js reads X's own label (below)
  src/popup/         popup UI
  src/marks/         "Your marks" page
  src/feedback/      "Send feedback" page
  src/ui/            design tokens and shared controls; page shell
  src/fonts/         Geist Sans and Geist Mono (OFL-1.1)
worker/
  src/index.js       public API: buckets, votes, tallies, export, feedback,
                     the Chrome Web Store waiting list
  src/admin.js       maintainer console: sign-in, review queue, inbox
  src/site.js        the website at killslop.app, and the shared static files
  src/policy.js      what gets served, and id and input validation (pure, tested)
  src/http.js        rate limits and request parsing
  public/admin/      console pages, served only through the sign-in check
  public/site/       the website: landing page, waiting list, privacy policy
  public/ui/         the same base.css as the extension (a test keeps them equal)
  migrations/        schema changes for an existing database, in order
test/                unit tests, live probe check, browser e2e
```

**The probe queue lives in the content script on purpose.** YouTube returns 403
for InnerTube requests carrying a `chrome-extension://` origin, so the service
worker physically cannot make them. The worker decides *what* to probe; the
content script performs the fetch and reports back.

**X's label is read in X's own page world.** A content script never sees the
page's requests, so `x-page.js` runs in the page (`"world": "MAIN"`), reads
the AI mark on each post in the API responses X already receives, and passes
a summary to `x.js`. It sends nothing and changes no request (RESEARCH.md
section 14).

## Privacy

Community lookups use SponsorBlock's hash-prefix trick: the client sends the
first 4 hex characters of `sha256(id)`, where the id is a video, post, channel
or account, and filters the returned bucket locally. The server never receives
an id you are asking about, so it cannot reconstruct what you watched or read.
4 characters = 65,536 buckets.

Four things do send data, and none of them is a browsing trail:

- a **vote**, when you click "not slop" or mark something: the id you
  marked;
- a **tally**, when a channel or X account you encountered crosses the
  disclosure threshold: its id and the sampled counts, once;
- **feedback**, when you send it: your message, the optional email, and the
  extension version. It is stored for the maintainer to read and never
  published;
- the **writing check**, only if you switch it on: the text of a post that
  nothing else could place. It ships off. Even on, the page's own gate settles
  most posts locally, and what is left is asked for by `sha256(text)` prefix
  first, so text is sent only for a post nobody has ever had checked. The
  server keeps the hash and the score and never the text.

Each vote carries a random install id. The server stores that id, and your
network (IPv4 address or IPv6 /64), only as `sha256(value + entry + salt)`.
That is enough to count you once per entry, and not enough to link your votes
on two different entries to each other. Voting twice on the same entry takes a
new install **and** a new network. Feedback keeps the network only as a salted
hash, to cap how much one network can send in a day.

Requests are rate-limited per network by Cloudflare's rate limiter, which
counts without storing anything. Probes are sent with `credentials: 'omit'`,
so they are never tied to your YouTube account. On X, the AI label is read
from data X has already sent to the page, which costs no request of our own.
On LinkedIn, KillSlop only reads the page and sends LinkedIn nothing.

## Development

```bash
npm test           # unit tests: classifier, parsing, thresholds, API, console auth
npm run test:live  # probe live YouTube URLs and assert verdicts
npm run test:e2e   # load into a real browser, verify it filters a live feed
npm run fixtures   # re-capture InnerTube fixtures
```

`test:e2e` needs `npm install` and Chrome for Testing, because stable Chrome
removed `--load-extension` in version 137:

```bash
npx @puppeteer/browsers install chrome@latest --path ./.browsers
```

Load it manually with **chrome://extensions, Developer mode, Load unpacked,
`extension/`**.

### Worker

```bash
cd worker
cp wrangler.example.toml wrangler.toml
npx wrangler d1 create killslop          # put the id in wrangler.toml
npm run db:init                          # applies schema.sql to the remote DB
npx wrangler secret put VOTER_SALT
npx wrangler secret put ADMIN_PASSWORD   # opens the console at /admin
npx wrangler deploy
```

One worker serves two hosts: `killslop.app` gets the website and
`api.killslop.app` the API and the console (`worker/src/site.js` decides by
host). The `routes` block in `wrangler.toml` binds both as custom domains; on
your own account, point it at a domain you own or delete it and use the
`workers.dev` address.

A database created before a schema change is brought up to date by running
the files in `worker/migrations/` it has not had yet, in order:

```bash
npx wrangler d1 execute killslop --remote --file=migrations/0002_review_feedback.sql
```

`worker/wrangler.toml` is gitignored because it names your own database;
`npm test` checks that it has not drifted from the example.

The extension degrades cleanly when the API is unreachable: community lookups
fail silently and the local tiers carry on.

## What it does not catch

Roughly 11% of AI slop carries YouTube's disclosure; the rest is undisclosed
and invisible to a label-based filter. Since 2026-05-27 YouTube auto-labels
"significant photorealistic AI", which helps, but animated kids' content, AI
voice-over-stock-footage and AI music stay outside the label by design.
Channel inference, the community list and the review queue exist to close
that gap. See RESEARCH.md sections 6, 7 and 11.

On X the label covers media only: AI-written posts and replies carry nothing,
and many AI accounts label only some of their images (RESEARCH.md sections 13
and 15). LinkedIn labels nothing at all (section 18); there, only people's
marks find slop.

## Licence and credit

The code is GPL-3.0, see `LICENSE`. The exported list is CC BY-SA 4.0. What we
borrowed and from whom is in [ATTRIBUTION.md](ATTRIBUTION.md).
