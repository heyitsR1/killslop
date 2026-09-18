# Contributing to KillSlop

KillSlop is building the shared, evidence-backed list of AI slop that any filter
can use, on YouTube, X and LinkedIn today. Help of every size counts, from a
wrong-call report to a selector fix when a site changes its markup to a whole
new platform.

## Without writing code

- **Use it.** With "Contribute reports" on (the default), pressing AI SLOP or
  Not slop feeds the review queue.
- **Report wrong calls.** A creator hidden who should not be, or slop that got
  through. Use the *Wrong call* issue form, or the extension's Send feedback
  page.
- **Report breakage.** YouTube, X and LinkedIn all change their markup often.
  The page link and a screenshot are usually enough.

## Read these first

- **[RESEARCH.md](RESEARCH.md)**: why detection works the way it does. Every
  rule in it came from a measurement, and several obvious-looking clean-ups
  silently break the product: moving the probe into the service worker,
  treating "How this was made" as an AI flag, or matching localised label
  text. Change a rule only with a new measurement, and update the document in
  the same pull request.

## Setup

Node 20 or newer. There is no build step: the extension loads straight from
`extension/`.

```bash
npm install        # only the browser e2e test needs it
npm test           # unit tests, no network
npm run test:live  # probes real YouTube videos
npm run test:e2e   # loads the extension into Chrome for Testing (see README)
```

Load the extension by hand at chrome://extensions: turn on Developer mode,
choose Load unpacked, and pick `extension/`.

### Running the worker locally

```bash
cd worker
cp wrangler.example.toml wrangler.toml
npx wrangler d1 execute killslop --local --file=schema.sql
npx wrangler dev --var ADMIN_PASSWORD:dev --var VOTER_SALT:dev
```

The console is then at http://localhost:8787/admin with the password `dev`.
`wrangler dev` answers every local request as the API host (`[dev] host` in
`wrangler.toml`); to see the website instead, add
`--local-upstream killslop.app`.
The extension talks to the production API (`API_BASE` in
`extension/src/core/community.js`). Point it at your local worker while you
test, and leave that change out of your commit.

`worker/wrangler.toml` is gitignored because it names the maintainer's own
database. `test/config.test.mjs` fails if it drifts from
`wrangler.example.toml`, so change both.

## Ground rules

**Privacy.**

- The read path never sends a full id. Lookups go by 4-character hash prefix,
  and must stay that way.
- One feature is allowed past that line, and only on these terms: the writing
  check sends a post's text, because there is no way to judge writing without
  it. It ships off, the page's own gate settles most posts without sending
  anything, the text is asked for by `sha256(text)` prefix before it is ever
  sent, and the server stores the hash and the score but never the text.
  Anything else that wants to send content has to clear the same four bars,
  and say so on the privacy page.
- Nothing may build a browsing history, on the client or on the server. Only
  deliberate clicks (votes), channel-level measurements (tallies), feedback
  and the opt-in writing check send anything identifying content.
- Anything that identifies a person is stored only as a salted hash, scoped
  so that two of their actions cannot be linked.
- New data collection gets a line in the README's Privacy section in the same
  pull request.

**Fairness.** A wrong entry is a public accusation against a real creator.

- Keep measurement (`disclosure`), machine reading (`writing`) and opinion
  (`vote`) apart end to end. They are three different claims with three
  different strengths: never add their counters together, and never let one
  be served under another's name.
- One person must never be able to hide something for everyone. `decide()` in
  `worker/src/policy.js` is the one place that decides what gets served.
  Change it only with tests.
- Every hidden tile says why it was hidden and offers a one-click reversal
  that outranks everything else.

**Code.**

- Plain JavaScript modules: no framework, and no bundler in the extension.
  Match the style of the file you are in.
- Comments explain *why*, especially anything that came from a measurement.
- UI text is plain and specific. No emojis in code, UI or docs.
- Pure logic lives where tests reach it (`extension/src/core/`,
  `worker/src/policy.js`) and changes to it come with tests.
- The console renders every stored value with `textContent`, never
  `innerHTML`: titles and feedback are written by strangers.

**Borrowing.** Only from projects with a compatible licence, and every
borrowing gets a row in [ATTRIBUTION.md](ATTRIBUTION.md). Projects without a
licence are inspiration only; do not copy their code.

**Schema.** Never edit a migration that has already run. Add the next
numbered file under `worker/migrations/`, keep it additive where you can, and
mirror the end state in `worker/schema.sql`.

## Adding a platform

The database is keyed by platform from the start, so a new platform is mostly
client work.

1. **Measure first.** Record in RESEARCH.md where the platform exposes an AI
   signal, if anywhere, what reading it costs, and what goes wrong.
2. Add a content script for its pages to `extension/manifest.json`, and a DOM
   adapter modelled on `extension/src/content/youtube.js`.
3. Teach the worker its ids: `isValidId()` in `worker/src/policy.js` and the
   platform allow-list in `worker/src/index.js`, with tests.
4. Switch its entry in `PLATFORMS` (`extension/src/core/settings.js`) from
   `planned` to `live`.

X and LinkedIn followed these steps; `extension/src/content/feed.js` does
most of the work for a feed of posts, and its adapters (`x.js`,
`linkedin.js`) are short. Next up: Reddit, Pinterest, Google Images, Spotify.

## Pull requests

- One change per pull request, with a description of what and why.
- `npm test` passes. For extension changes, say which pages you checked by
  hand.
- No secrets, `.dev.vars`, `worker/wrangler.toml`, database ids or real user
  data in the diff.

## Licence

The code is GPL-3.0 (see `LICENSE`), and by contributing you agree your
contribution is licensed the same way. The list itself (the public export) is
CC BY-SA 4.0: the votes, reports and reviews it is built from become part of
a dataset anyone may use and share, with credit to KillSlop, under the same
licence.
