# KillSlop

A browser extension that hides AI-generated slop, and an open,
evidence-backed list of it that anyone can use. YouTube first, then
LinkedIn, then X. The code is GPL-3.0; the list is CC BY-SA 4.0.

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

## How it decides

Five tiers, cheapest first. The first one that answers wins.

| # | Tier | Cost | Notes |
|---|---|---|---|
| 0 | Your own override | free | Absolute. Your "not slop" click outranks YouTube and the community. |
| 1 | Local cache | free | Verdicts don't expire: a disclosure never changes. |
| 2 | Channel inference | free | Where the coverage comes from. At least 60% of at least 5 sampled uploads labelled means the channel is hidden. |
| 3 | Community list | 1 request per hash bucket | Batched, privacy-preserving, evidence-tagged (below). |
| 4 | InnerTube probe | ~1 KB per video | Throttled, background, once per video ever. |

## Marking things yourself

Watch pages get an **AI SLOP** button beside like/dislike, and Shorts get one
in the action bar. Grey means you can press it. Pressed, it turns solid red:
the video is hidden from your feeds at once, and the confirmation offers
**Hide whole channel** and **Undo**. A red *tint* means KillSlop already treats
it as slop; hovering says why, and pressing it offers **Not slop**.

Your mark hides things **for you**, instantly. It hides nothing for anyone
else. The server keeps each vote in mind, and while the list is young a
maintainer checks every entry before it is served to anyone (see the review
queue below). One person cannot bury a channel. What counts as a "person" is
under Privacy.

Everything you have marked is listed on the **Your marks** page (popup, then
Your marks), each with a Remove button.

## The community list carries evidence

Each entry says *why* it is on the list:

- **`disclosure`**: another client's sampler watched this channel cross the
  tier-2 threshold on YouTube's own labels. Clients share this automatically
  when "Contribute reports" is on. The server re-checks the numbers and
  records one per reporter.
- **`vote`**: people clicked "slop" or "not slop".
- **`review`**: a maintainer checked it by hand and nothing was measured.

Turning off "Include opinion votes" in the popup restricts the list to
measured entries, which cannot produce an opinion-based false positive.

Decided channels are exported in the clear under
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) at
<https://api.killslop.app/api/v1/export/youtube-channels.json>, so uBlock
lists, ReVanced-style patches and researchers can consume them without
running the extension. Anyone may use and share the list, commercially too,
as long as they credit KillSlop and release what they build from it under
the same licence.

## The review queue

Every vote and measurement lands in a queue in the maintainer console at
`api.killslop.app/admin`, behind a password. For each entry the console shows how
many people reported it and how strongly, and runs its own check against
YouTube: the video's AI label, or the labels on a channel's six most recent
uploads, with thumbnails. Approving an entry puts it in the **final
database**; rejecting it keeps it off the list whatever the votes say. The
same console holds the feedback inbox.

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
optional email for a reply. Opened from a YouTube tab, it offers to attach
that page's link. Messages go to the console's inbox.

## Roadmap

1. **YouTube**: live.
2. **LinkedIn**: AI-written posts and comments.
3. **X**.

The database is keyed by platform from the start (a `platform` column on
every entry), so a new platform is a content script and an id validator, not
a migration. CONTRIBUTING.md has the steps.

## Where the code lives

```
extension/
  src/core/          policy: classification, cache, community client, settings
  src/background/    message router; owns storage and the community list
  src/content/       DOM adapter + the probe queue (see below)
  src/popup/         popup UI
  src/marks/         "Your marks" page
  src/feedback/      "Send feedback" page
  src/ui/            design tokens and shared controls; page shell
  src/fonts/         Geist Sans and Geist Mono (OFL-1.1)
worker/
  src/index.js       public API: buckets, votes, tallies, export, feedback
  src/admin.js       maintainer console: sign-in, review queue, inbox
  src/site.js        the website at killslop.app, and the shared static files
  src/policy.js      what gets served, and id and input validation (pure, tested)
  src/http.js        rate limits and request parsing
  public/admin/      console pages, served only through the sign-in check
  public/site/       the website: landing page and privacy policy
  public/ui/         the same base.css as the extension (a test keeps them equal)
  migrations/        schema changes for an existing database, in order
test/                unit tests, live probe check, browser e2e
```

**The probe queue lives in the content script on purpose.** YouTube returns 403
for InnerTube requests carrying a `chrome-extension://` origin, so the service
worker physically cannot make them. The worker decides *what* to probe; the
content script performs the fetch and reports back.

## Privacy

Community lookups use SponsorBlock's hash-prefix trick: the client sends the
first 4 hex characters of `sha256(videoId)` and filters the returned bucket
locally. The server never receives an id you are asking about, so it cannot
reconstruct a watch history. 4 characters = 65,536 buckets.

Three things do send data, and none of them is a browsing trail:

- a **vote**, when you click "not slop" or mark something: the id you
  marked;
- a **tally**, when a channel you encountered crosses the disclosure
  threshold: the channel id and the sampled counts, once;
- **feedback**, when you send it: your message, the optional email, and the
  extension version. It is stored for the maintainer to read and never
  published.

Each vote carries a random install id. The server stores that id, and your
network (IPv4 address or IPv6 /64), only as `sha256(value + entry + salt)`.
That is enough to count you once per video, and not enough to link your votes
on two different videos to each other. Voting twice on the same video takes a
new install **and** a new network. Feedback keeps the network only as a salted
hash, to cap how much one network can send in a day.

Requests are rate-limited per network by Cloudflare's rate limiter, which
counts without storing anything. Probes are sent with `credentials: 'omit'`,
so they are never tied to your YouTube account.

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

## Licence and credit

The code is GPL-3.0, see `LICENSE`. The exported list is CC BY-SA 4.0. What we
borrowed and from whom is in [ATTRIBUTION.md](ATTRIBUTION.md).
