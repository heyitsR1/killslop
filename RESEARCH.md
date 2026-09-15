# KillSlop — YouTube research

Everything here was measured, not assumed. Reproduce with `npm run test:live`
and the probe scripts under `test/`. Measured 2026-08-16.

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
