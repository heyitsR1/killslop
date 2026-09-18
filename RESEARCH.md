# KillSlop research

Everything here was measured, not assumed. Sections 1 to 11 cover YouTube
(measured from 2026-08-16; reproduce with `npm run test:live` and the probe
scripts under `test/`), 12 to 17 X, and 18 to 22 LinkedIn.

---

## 1. Where the AI signal is, and isn't

| Source | Carries AI disclosure? |
|---|---|
| Feed responses (`search`, `browse`, recommendations) | **No.** Nothing, on any surface. |
| Data API v3 `status.containsSyntheticMedia` | **No.** Write-only — settable on `videos.insert`/`update`, never returned. |
| InnerTube `player` | **No.** |
| InnerTube `next` (watch endpoint) | **Yes.** |

This is the constraint the whole product is shaped around: **a feed response
tells you nothing, so there is no way to avoid one request per video.**

The two fields on `next`:

- `videoPrimaryInfoRenderer.badges[].metadataBadgeRenderer` — the "AI" chip
- `structuredDescriptionContentRenderer` → `howThisWasMadeSectionViewModel`

---

## 2. Trap: `howThisWasMadeSectionViewModel` is not an "is AI" flag

It is a generic "how this was made" container. It also carries **"Auto-dubbed"**
— machine translation of the audio track, which has nothing to do with
AI-generated content.

Filtering on its presence flagged, in a 208-video sample:

- National Geographic
- Veritasium
- Motiversity
- History Matters

**29 of 208 videos (14%) were auto-dub false positives.**

The discriminator is structural: an AI disclosure gets a badge on
`videoPrimaryInfoRenderer`; an auto-dub gets **none**.

```
                        howThisWasMade      videoPrimaryInfoRenderer.badges
  Made with AI          present             [{ SIMPLE, INFO }]
  Auto-dubbed           present             undefined
  ordinary video        absent              undefined
```

`test/classifier.test.mjs` locks this in against real captured responses.

---

## 3. Trap: the disclosure text is localised

| `hl` | `bodyHeader.content` | badge |
|---|---|---|
| `en` | Made with AI | `SIMPLE` / `INFO` |
| `ne` | AI प्रयोग गरी बनाइएको | `SIMPLE` / `INFO` |
| `es` | Creado con IA | `SIMPLE` / `INFO` |
| `ja` | AI 生成 | `SIMPLE` / `INFO` |

The badge shape is stable; the text is not. We force `hl: 'en'` on our own
request so the cheap text path is deterministic regardless of the user's locale.

---

## 4. Client choice: cost vs. signal

Response sizes for the same video on `next`:

| Client | AI video | auto-dub | ordinary | has `howThisWasMade` | has `videoPrimaryInfoRenderer` |
|---|---|---|---|---|---|
| WEB | 1072 KB | 415 KB | 407 KB | yes | **yes** |
| TVHTML5 | 209 KB | 121 KB | 135 KB | yes | no |
| MWEB | 630 KB | — | — | **no** | no |
| WEB_EMBEDDED_PLAYER | 100 KB | — | — | **no** | no |
| ANDROID / IOS | — | — | — | 400 `FAILED_PRECONDITION` | — |

TVHTML5 is 5x cheaper but lacks the structural discriminator. Hence the two-step
strategy actually implemented:

1. **TVHTML5 with `hl=en`** — classify on the header string.
2. If the header is one we don't recognise, **escalate to WEB** and classify
   structurally on the badge.

Cheap in the common case, self-healing if YouTube rewrites the copy.

---

## 5. Trap: the probe cannot run in the service worker

YouTube answers `/youtubei/v1/next` with **HTTP 403 "Sorry..."** when the
request carries a `chrome-extension://` origin.

```
from Node (no Origin header)          200, 213 KB, signal present
from extension service worker         403, Google abuse page
from youtube.com page origin          200, 213 KB, signal present
```

So the fetch **must** be issued by the content script, which runs at
youtube.com origin. The service worker keeps cache, policy and community
lookups; the content script owns the probe queue. This is not a style
preference — moving the fetch back into the worker breaks the product silently.

---

## 6. Recall: only ~11% of slop is labelled

208 videos across 12 searches, counting only real "Made with AI" disclosures:

| Query | Labelled |
|---|---|
| ai generated relaxing music | 8/16 |
| bible stories | 5/19 |
| trending music 2026 | 5/18 |
| lofi songs | 2/19 |
| true crime story | 1/20 |
| sleep music 8 hours | 1/18 |
| motivational speech | 1/20 |
| asmr sleep story | 0/20 |
| facts about space | 0/20 |
| minecraft gameplay | 0/19 |
| cute animal videos | 0/16 |
| history documentary shorts | 0/3 |
| **total** | **23/208 (11.1%)** |

Disclosure is self-declared, so it is wildly under-used. But precision is high
and the labels cluster exactly where the slop is — near zero in
minecraft/space/animals, high in AI music and bible-animation farms.

---

## 7. The finding the product is built on: channels are bimodal

Per-video labelling is patchy. Per-channel it is almost binary:

| Channel | Labelled uploads |
|---|---|
| Eigi and AI | 12/12 |
| chill chill journal | 12/12 |
| Eden \| Bible Animation | 9/10 |
| Moonlit Lofi | 3/3 |
| National Geographic | 0/12 |
| Veritasium | 0/12 |
| Motiversity | 0/12 |
| Pure Grit Studio | 0/12 |

Slop farms label nearly everything; real channels label nothing. So **the
channel is the unit of filtering, not the video.** Once a channel is tallied,
every future video from it resolves for free — including uploads the creator
forgot to label.

Default thresholds: `channelMinSamples: 5`, `channelThreshold: 0.6`.

### Known limitation

Undisclosed AI stays invisible to a label-based filter. "Pure Grit Studio" and
"a home for tired minds" look like slop and score 0/12. Heuristic detection
(title/thumbnail/upload-cadence signals) would raise recall at the cost of
precision, and should stay opt-in if it is ever added.

---

## 8. Update 2026-09-12: the probe is now one ~1 KB request

InnerTube honours a `fields` mask on `next`. Measured on the same videos as §4:

| Client + mask | AI video | auto-dub | ordinary | badge | header | owner |
|---|---|---|---|---|---|---|
| WEB, masked | **1.2 KB** | 0.8 KB | 0.7 KB | yes | yes | yes |
| TVHTML5 (old cheap path) | 209 KB | 121 KB | 135 KB | no | yes | yes |
| WEB (old escalation) | 1072 KB | 415 KB | 407 KB | yes | yes | yes |

The mask keeps exactly three things: `videoPrimaryInfoRenderer.badges`, the
owner's `browseEndpoint`, and `howThisWasMadeSectionViewModel.bodyHeader`. So
the two-step TVHTML5-then-WEB strategy of §4 is gone: one masked WEB call
carries the structural discriminator *and* the forced-English header. The
header is now only a fallback for a response with the section but no primary
info (mask drift).

Credit: the mask trick is from Weedout (MIT), see `ATTRIBUTION.md`.

The badge's accessibility label is `"AI: Content was made with AI"`; the
visible text is just `"AI"`. We still grade on `style === SIMPLE && icon ===
INFO` because that is locale-independent.

## 9. Update 2026-09-12: the sidebar carries no channel link

Inspected live. The watch sidebar's `yt-lockup-view-model` tiles link **only**
to `/watch?v=`; the channel is plain text. Search results (`ytd-video-renderer`)
and the home grid (`ytd-rich-item-renderer` wrapping a lockup) still carry a
`/@handle` or `/channel/UC…` link.

So channel inference got no channel id for sidebar tiles — the surface where
recommendations do the most damage. Fix: the probe response carries the owner
(`videoOwnerRenderer.navigationEndpoint.browseEndpoint` → `browseId` UC id and
`canonicalBaseUrl` handle) in both WEB and TVHTML5, so every probe now returns
`owner: {ucid, handle}`, tallies are keyed by UC id, and handles seen on tiles
are stored as aliases of the UC id.

Also found: the home grid nests the new lockup inside the classic rich-item.
A selector that matches both marks the tile twice. Only the outermost match
is a tile now. The current Shorts shelf component is
`ytm-shorts-lockup-view-model-v2`; `ytd-reel-item-renderer` is legacy.

## 10. Update 2026-09-12: the watched video needs no probe

On the watch page the disclosure is in the DOM: a `badge-shape` with the AI
label inside `yt-metadata-badge-renderer` under the title, and a
`how-this-was-made-section-view-model` element in the description panel. Both
are also in `ytInitialData` (page-world only). Reading them is a free tier-1
signal for the video being watched; not yet implemented.

## 11. Platform change that matters: auto-labels since 2026-05-27

YouTube now applies the label itself when "our systems detect significant
photorealistic AI use", and the label moved to directly under the player. This
raises label recall for photorealistic slop and does nothing for animated
kids' content, AI voice-over-stock-footage, or AI music — which is exactly
where channel inference and the community list have to carry the load. The
§6 measurement (11.1% of a slop-heavy sample labelled) was taken after this
change.

---

# X

Measured 2026-09-15 on the logged-in desktop web client (x.com), reading the
page's own API responses from inside the page.

## 12. X puts the AI signal in the feed itself

| Source | Carries AI disclosure? |
|---|---|
| Timeline JSON (home `…/flow/timeline.json`, GraphQL `SearchTimeline`, and the same `Tweet` object everywhere) | **Yes**, on every post that has one. |
| The rendered post | Yes, as plain text under the media: "Made with AI", "Made with Grok Imagine". |
| Public API v2 | **No.** `paid_partnership` is documented; nothing AI-related. |

The field, on the `Tweet` object next to `legacy` and `core`:

```
content_disclosure.ai_generated_disclosure
  has_ai_generated_media           true
  can_edit                         false   X detected it
                                   true    the author declared it
  ai_generated_detection_source    "C2paClient"     C2PA manifest in the upload
                                   "GrokSignature"  made with X's own Grok
                                   "UserDeclared"   the author's toggle
                                   (absent)         seen with can_edit: true
```

This is the opposite of YouTube (§1): the feed response already says which
posts are labelled, so **X needs no probe tier at all**. Reading the label
costs nothing beyond the requests the page makes anyway.

| Sample | Posts | Labelled | Sources |
|---|---|---|---|
| Search "grok imagine" | 29 | 11 | 8 C2paClient, 3 GrokSignature |
| Search "chatgpt image filter:images" | 23 | 7 | 4 C2paClient, 1 UserDeclared, 2 no source |
| Home, For You, four pages | ~26 | 0 | |

## 13. Trap: the label is a media label, and only as good as provenance

The key is `has_ai_generated_media`. No text-only post carried it: not in the
samples above, and not among the replies under a 50M-view AI video. AI-written
text on X, which is most reply slop, has no platform signal at all.

Media is labelled only when the file proves where it came from (C2PA, Grok's
own signature) or the author says so. Screenshots, re-encodes and generators
that do not sign leave no trace, which is why the accounts in §15 are far
from fully labelled.

## 14. Trap: the rendered label is not a stable hook

The "Made with AI" line has no `data-testid`, no `aria-label` and no role; it
is a text node, and its wording changes with the tool ("Made with Grok
Imagine"). Matching it would repeat YouTube's localised-text trap (§3).

So the X adapter reads the JSON, not the label. A content script's isolated
world never sees the page's own requests, which leaves one route: a script in
the page's world (`"world": "MAIN"`, at `document_start`, before X's bundle
captures `fetch`) that wraps `fetch` and `XMLHttpRequest`, walks each API
response for `__typename: "Tweet"` objects, and hands the isolated content
script `{post id, author id, handle, labelled, source}`. It sends nothing
anywhere and changes no request.

## 15. Accounts are not bimodal on X

The YouTube finding (§7) does not carry over. Media posts per account, from
`from:<handle> filter:media`, first two pages:

| Account | Media posts labelled |
|---|---|
| AI image account A | 23/34 (68%) |
| AI image account B | 12/24 (50%) |
| AI prompt-sharing account C | 8/20 (40%) |
| AI celebrity-image account D | 7/20 (35%) |
| Grok video account E | 4/20 (20%) |
| AI illustration account F | 3/21 (14%) |
| NASA | 0/21 |
| NatGeo | 0/20 |
| elonmusk | 0/20 |

AI accounts are identified by name and bio and label 14-68% of their media.
Ordinary accounts label nothing: 0 of 61. The patchiness is not an artefact of
the label's age: restricted to posts since 2026-06-01, D, E and F came out at
4/20, 3/20 and 2/20.

YouTube's rule (at least 60% of at least 5) would catch one of these six
accounts. A lower bar still separates this sample cleanly: **at least 25% of at
least 8 media posts** catches A to D and none of the controls. Treat that as a
starting point to re-measure on a larger sample, not a settled constant; E and
F show the label alone will never find every AI account.

## 16. Stable ids

| Thing | Id | Where it is |
|---|---|---|
| Post | `rest_id`, numeric string | JSON, and every `/<handle>/status/<id>` link |
| Author | `user.rest_id`, numeric string | JSON only |
| Author handle | `core.screen_name` | JSON, and the post's `User-Name` links |

The handle is the only author id in the page, but its owner can change it. So,
as on YouTube (§9): tally by `rest_id`, keep handles as aliases.

DOM facts the adapter relies on: a post is `article[data-testid="tweet"]`
inside a `cellInnerDiv`; its own permalink is the `/status/` link that wraps a
`<time>`, which keeps a quoted post's link from being taken for the outer
one; the author is the first link in `[data-testid="User-Name"]`; the action
row is `[role="group"]` holding `reply`, `retweet`, `like` and `bookmark`.

## 17. What X does itself

From X's own announcements, not measured here: the synthetic-media policy
(2020) labels or removes deceptive media; Community Notes can attach to every
copy of an image; since 2026-03 Premium users can downvote a reply as "AI
generated", which only affects reply ranking and is not exposed; accounts
that automate replies with chatbots are removed in batches. None of these
appear in the post data the page receives, except `content_disclosure`.

---

# LinkedIn

Measured 2026-09-15 on the logged-in desktop web client, in a Playwright
browser, reading DOM and responses only.

## 18. There is no AI signal in the feed

LinkedIn's web client moved to server-driven UI rendered as React Server
Components. The feed is the initial HTML plus `POST
/flagship-web/rsc-action/actions/pagination?sduiid=com.linkedin.sdui.pagers.feed.mainFeed`
(3.6 MB for eight posts). The old `voyager` REST and GraphQL calls now serve
navigation and messaging, not posts. Class names are hashed and posts carry
no `data-urn`.

| Source | Carries AI disclosure? |
|---|---|
| Feed payload | **No.** Only whether media has a C2PA manifest (`viewName: "c2pa-button"`). |
| "CR" button on the media | Presence of provenance, not AI (§19). |
| C2PA manifest request, `sduiid=…media.c2pa.manifest.data` (7.7 KB, one POST per asset) | Issuer and app, as display text only. |
| The image file on `media.licdn.com` | **No.** 0 of 9 files, including three with a CR button, kept any C2PA, XMP or EXIF bytes. |
| "Seems like AI slop" in the post menu | Goes to LinkedIn; nothing comes back into the page. |

## 19. Trap: the CR button is not an AI flag

The same trap as YouTube's "How this was made" (§2). The panel reads
identically for an AI image and an edited photo:

```
                    App or device used          Issued by
  ChatGPT image     OpenAI Media Service API    OpenAI OpCo, LLC
  ad photo          Adobe Photoshop             Adobe Inc.
```

Above both: "Source or history information is available for this media."
The words "AI" or "generated" appear nowhere. Only the issuer tells them apart,
and reading it costs a POST per image. On the main feed 1 of 8 posts had a CR
button (the Photoshop ad); on a search for "made with chatgpt" images, 3 of 9
results did, all issued by OpenAI.

## 20. Posts are identified by a hash of their URN

A post is `[role="listitem"]` whose `componentkey` is

```
expanded + base64url(sha256("urn:li:activity:<id>")) + FeedType_MAIN_FEED_RELEVANCE
```

(`FeedType_FLAGSHIP_SEARCH` on search results). Hashing every URN found in the
payloads matched 6 of 8 feed posts; the two misses were both ads. The URN
itself reached the DOM for 1 of 8 posts, and only through a rendered comment
(`replaceableComment_urn:li:comment:(activity:<id>,<id>)`).

So the post id the page gives us is the 43-character hash. It is stable, it is
what any client sees for the same post, and a maintainer can compute it from
a pasted post link. It cannot be reversed into a URN, which suits a list that
never needs one.

## 21. Author ids

The author is a `/in/<slug>` (person) or `/company/<slug>` link. The first
profile link in a post is often someone else: "X and Y reacted to this" sits
above the author. What identifies the author reliably is the post's menu
button, `aria-label="Open control menu for post by <Name>"`: the author's link
is the first `/in/` or `/company/` link whose text contains that name. That
held for 8 of 8 posts, ads included. Slugs are vanity names the owner can
change; the member URN appears only on Connect buttons.

The action row under a post is three buttons with stable labels: the
reaction button, `Comment` and `Repost`.

## 22. What this means for LinkedIn

- **No label tier and no channel inference.** Nothing free says a post is AI,
  so there is nothing to tally. LinkedIn runs on the community list and the
  user's own marks until LinkedIn exposes something.
- **Passive only.** The feed loads bot defence (`li.protechts.net` with
  `uc=scraping`, reCAPTCHA Enterprise), and LinkedIn's help centre bans
  extensions that "scrape, modify the appearance of, or automate activity".
  The adapter reads the DOM it is given and makes no requests to LinkedIn of
  its own; the CR manifest request of §19 stays unused.
- **Text is the slop.** Undisclosed AI-written posts and comments are what
  LinkedIn users mean by slop, and no platform signal covers them. LinkedIn's
  own answer (2026-07-30) is the private "Seems like AI slop" report plus
  reduced reach, with no public label.

---

# The writing check

Measured 2026-09-18 against Jev 1.13 (TypeSafe), one post per request, through
the same code path the worker uses (`worker/src/jev.js`).

## 23. Reading the words catches what no label does, and the bar is 2.5

§13 and §15 leave X's text posts unlabelled, and §18 leaves LinkedIn with no
signal at all, so a post made of words reached the end of the ladder and was
called clean. §7's known limitation anticipated exactly this tier and set its
condition: detection that reads the content rather than a label "should stay
opt-in if it is ever added". It is, and this is the measurement it rests on.

Fifty labelled posts (`test/fixtures/writing-eval.json`), 15 slop and 35
human, scored 0 to 4 on the rubric adapted from Wikipedia's *Signs of AI
writing* (ATTRIBUTION.md). Eighteen of the human half were written to be hard
rather than easy: non-native English in several registers, polished technical
prose, genuine enthusiastic announcements, and human writing that uses the
same "not X, but Y" contrast the rubric looks for. Four are real posts taken
off a live timeline. Run it with `node scripts/eval-classifier.mjs labelled`.

| Threshold | Caught | False positives | Precision | Recall |
|---|---|---|---|---|
| 2.0 | 15/15 | 0/35 | 1.000 | 1.000 |
| 2.5 | 15/15 | 0/35 | 1.000 | 1.000 |
| 3.0 | 14/15 | 0/35 | 1.000 | 0.933 |
| 3.5 | 9/15 | 0/35 | 1.000 | 0.600 |

The threshold is chosen by where the two classes separate, not by the table:

| | Score |
|---|---|
| Highest human ("It's not that remote work doesn't function. It's that...") | 1.75 |
| Lowest slop (LinkedIn humblebrag, "Humbled and honored to share...") | 2.97 |

**Default: `HIDE_AT = 2.5`** (`extension/src/core/writing.js`), which sits in
that 1.22-wide gap with 0.75 of headroom above the worst human case.

A higher bar is not automatically a safer one. 3.0 falls *inside* the bottom of
the slop cluster and loses the humblebrag and the announcement, which are the
two commonest shapes on LinkedIn. 2.0 scores identically to 2.5 here but leaves
only 0.25 of headroom, which is too little to carry off this corpus. If this
number is ever moved, move it up: recall costs a post nobody reads, precision
costs a person.

### Known limitation

Fifty posts is a sample, not a study, and 31 of them were written for the
purpose rather than drawn from a feed, which flatters separation: real writing
is messier than either class here. Precision of 1.000 means no false positive
was observed in 35 human posts, not that the rate is zero.

Two things remain unmeasured. The share of a real timeline the gate sends is
still unknown, because X's feed virtualization defeated three attempts to
harvest a usable sample; `scripts/eval-classifier.mjs feed` exists to measure
it as soon as one can be collected. And nothing here measures LinkedIn prose
specifically, which is where the check matters most.

## 24. Trap: the rubric flags non-native English unless told not to

The most important sentence in the question is the last one:

> Non-native English, awkward grammar, translation artefacts, typos, and
> unusual phrasing are signs of a HUMAN writer, not of AI.

Without it the model reads unusual English as machine English, and the check
would hide people for writing in a second language. With it, both non-native
samples scored below 0.9, and one scored 0.69 through the live worker route.
`test/writing.test.mjs` asserts the sentence is still present, because it is
the kind of line a tidy-up removes.

The same trap sits in the local gate: `extension/src/content/slopsigns.js` is
tested against the same posts, because a gate that held them back would deny
them even the chance to be cleared.

## 25. One post per request, not ten

Batching ten posts into one `state` and asking a question per index cost 217
input tokens a post against 451, and was measurably worse:

| Post | Asked alone | In a batch of ten |
|---|---|---|
| Human debugging complaint | 0.02, confidence 0.99 | 2.57, confidence 0.15 |
| X thread template | 3.92, confidence 0.93 | 3.53, confidence 0.61 |

That matches TypeSafe's documented weaknesses at indirection and at state full
of content irrelevant to the question. Halving the cost is not worth a wrong
answer about a real person.

Cost at one post per request, two questions: about 835 input tokens, roughly
**$0.035 per thousand posts**, about 1 second each and parallelisable. The
local gate holds back most of a feed before any of that is spent.

## 26. Trap: the gate was the bottleneck, not the model

The local gate (`extension/src/content/slopsigns.js`) first shipped requiring
either a structural sign (negative parallelism, an arrow or numbered listicle)
or two softer ones, reasoning that a lone sign would catch enthusiastic human
writing. Measured over the 50-post set, that reasoning was wrong twice:

| Gate rule | Slop sent | Slop held back | Human posts sent |
|---|---|---|---|
| Structural sign, or two soft | 8/15 | **7** | 3/35 |
| **Any sign at all** | 15/15 | **0** | **3/35** |

Every one of the seven held back had tripped exactly one sign, and they were
the commonest shapes on LinkedIn: the humblebrag, the generic motivational
post, the corporate abstract noun pile. Meanwhile the strict rule saved
nothing, because **32 of the 35 human posts trip no sign at all** — the gate
simply does not see ordinary human writing, so demanding two signs only ever
penalised slop. Loosening it moved recall at the shipping threshold from 0.53
to 1.000 and left both cost and text egress unchanged.

The lesson is about where a filter's errors hide. End-to-end recall was poor
while the model was performing perfectly; the loss was upstream, in a cheap
local rule nobody was measuring. A tier that silently declines to ask is
indistinguishable, from the outside, from a tier that asks and gets it wrong.

Worth saying plainly, because it nearly stood: the gate's own unit test
asserted "slop wrongly held back: 0" and passed the whole time. It was checked
against five posts, and the gate had been written against those same five. It
took a corpus the gate had never seen to show the rule was wrong.
