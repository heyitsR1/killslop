# Attribution

KillSlop is GPL-3.0 (see `LICENSE`). Ideas and, where noted, code were taken
from the projects below. Ideas are not copyrightable; code is, and every
copied line keeps its licence and its author.

| What | From | Licence | How used |
|---|---|---|---|
| Hash-prefix privacy lookup (`sha256(id)` prefix → bucket, filter locally) | [SponsorBlock](https://github.com/ajayyy/SponsorBlockServer) by Ajay Ramachandran | AGPL-3.0-only (server), GPL-3.0 (extension) | Idea reimplemented in `extension/src/core/community.js` and `worker/`. No code copied. |
| `fields` mask on `youtubei/v1/next` to shrink the response | [Weedout for YouTube](https://github.com/masteranza/weedout-for-youtube) by masteranza | MIT | Idea; our field list was derived independently and adds the owner and disclosure header. |
| Grading the badge by `accessibilityData.label` / `icon.iconType` | [ai-slop-blocker](https://github.com/mrlancelot/ai-slop-blocker) | MIT | Confirmed our structural rule; no code copied. |
| Report button beside like/dislike (`ytd-watch-metadata #top-level-buttons-computed`) | [slop-extension](https://github.com/ajayyy/slop-extension) by Ajay Ramachandran | GPL-3.0 | Placement idea. Theirs opens a category form; ours is one click plus undo. No code copied. |
| Vote-visibility threshold, reputation ranking, one-vote-per-IP, shadow-hide, request-validator | SponsorBlock server | AGPL-3.0-only | Ideas for the community tier; reimplemented. |
| Geist Sans and Geist Mono typefaces | [Geist](https://github.com/vercel/geist-font) by Vercel in collaboration with basement.studio | OFL-1.1 | The variable fonts ship unmodified in `extension/src/fonts/` and `worker/public/fonts/`, each with the licence as `OFL.txt`. |
| Visual language: black and white, hairline gray borders, tight type | Vercel's Geist design system | none (not code) | Style only. Our tokens and CSS are written from scratch; no Vercel code, logo, mark or name is used. |
| The rubric the writing check asks about: AI vocabulary, negative parallelism, rule of three, listicle templates, significance puffery, vague attribution | [Wikipedia: Signs of AI writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing) by its editors | CC BY-SA 4.0 | Text, not code. The signs are adapted, and cut down to the ones that survive in a post of a few hundred characters, in `worker/src/jev.js` and `extension/src/content/slopsigns.js`. Share-alike is satisfied: the list those signs help decide is published under the same licence. |
| The model the writing check asks | [Jev](https://docs.typesafe.ai) by TypeSafe | commercial API, not code | A service, called from `worker/src/jev.js` only. No code copied, and the key never ships in the extension. |

Projects looked at and deliberately **not** copied because they carry no
licence: SlopBlock (lydonator), youtube-ai-slop-dataset, Slop Evader,
youtube-ai-slop-visual-blocker.

Community lists `scripts/measure-channels.mjs` reads as *verification
candidates* (never as verdicts: a channel enters the list only on its own
uploads' AI labels, measured by us) and their terms: CevvalYoutubeAIBlocklist
(CC0); AiSList (CC BY-NC 4.0), only with its author's permission.
