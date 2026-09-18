/**
 * Signs of AI writing, read locally and for free.
 *
 * This is a gate, not a verdict. It decides only whether a post is worth
 * asking the writing check about (core/writing.js); the model decides what
 * the post actually is. So it leans towards saying yes: a post it waves
 * through costs a request, while a post it wrongly holds back is never
 * looked at again. The point is that the great majority of a feed trips
 * nothing, and the text of those posts never leaves the browser at all.
 *
 * The signals come from Wikipedia's "Signs of AI writing" (CC BY-SA 4.0,
 * see ATTRIBUTION.md), keeping the ones that survive in a post of a few
 * hundred characters. The ones that need an article's worth of structure
 * (heading levels, citation shape, section summaries) are left out.
 *
 * Loaded as a plain content script, like parse.js, because a content script
 * cannot be a module. It publishes globalThis.KillSlopSigns.
 */

(() => {
  'use strict';

  /**
   * Below this there is not enough writing to read anything off. Short posts
   * scored near zero in every measurement, and they are most of a feed.
   */
  const MIN_CHARS = 60;

  /**
   * Words that cluster in LLM prose. A single one says nothing: "crucial" and
   * "landscape" are ordinary English. Two distinct ones in a few hundred
   * characters is the signal.
   */
  const AI_VOCABULARY =
    /\b(delve|delves|delving|intricate|intricacies|underscore[sd]?|pivotal|crucial|leverage[sd]?|leveraging|unlock(s|ing|ed)?|landscape|testament|realm|navigat(e|es|ing)|tapestry|robust|seamless(ly)?|holistic|multifaceted|nuanced|elevate[sd]?|foster(s|ing)?|empower(s|ing|ed)?|resonate[sd]?|paradigm|synerg(y|ies|istic))\b/gi;

  const PUFFERY =
    /\b(game[- ]?changer|pivotal moment|marks? a shift|changes everything|a new era|the future of|revolutioniz(e|es|ing)|redefin(e|es|ing)|transformative|nothing short of)\b/i;

  /**
   * The announcement register. On LinkedIn this is the commonest shape of all,
   * and it carries no arrows and no AI vocabulary, so without it the template
   * humblebrag would never be looked at.
   */
  const PROMOTIONAL_TONE =
    /\b(thrilled|excited|delighted|humbled|honou?red)\s+to\s+(announce|share|be)\b|\b(grateful|blessed)\s+(to|for)\b|\bonwards and upwards\b|\bmy (personal )?journey\b|\bproud to (announce|share)\b/i;

  /** Weasel sourcing with nobody behind it. */
  const VAGUE_ATTRIBUTION =
    /\b(studies show|research shows|experts agree|industry reports?|observers (say|argue|note)|it is widely (known|believed)|many (would )?argue)\b/i;

  /**
   * "It's not about X. It's about Y." and "Not X, but Y." The strongest single
   * tell in a short post, and rare in ordinary speech.
   */
  const NEGATIVE_PARALLELISM = [
    // The gap may be empty: "It's not." on its own line, then "It's about X."
    // is the tightest form of the template and the one worth catching most.
    // \b\s* rather than \s+ after "not": in "It's not." the next character is
    // the full stop, and demanding a space there missed the tightest form.
    /\b(it|this|that)('s| is| was)\s+not\b\s*(just\s+)?(about\s+)?[^.!?\n]{0,70}[.!?\n]+\s*(it|this|that)('s| is| was)\b/i,
    /\bnot\s+(just\s+)?[^,.!?\n]{1,50},\s*but\s+(also\s+)?/i,
    /\byou('re| are)\s+not\s+[^.!?\n]{1,50}[.!?\n]+\s*you('re| are)\b/i,
  ];

  /**
   * Arrow bullets, numbered takeaways, stacked one-line paragraphs. The bullet
   * characters are written as escapes so the file stays ASCII and greppable.
   */
  const BULLET_LINE =
    /^\s*(?:[-*\u{2022}\u{2023}\u{25E6}\u{2043}]|->|=>|\u{2192}|\u{27A1}|\d+[.)])\s+\S/u;

  /**
   * Ends by asking for a reply rather than saying anything. The pointing-hand
   * characters are written as escapes: the repo carries no emoji in source.
   */
  const ENGAGEMENT_BAIT =
    /(which one are you|thoughts\?|agree\?|am i wrong|change my mind|drop a|comment below|let me know (below|in the comments)|repost if|follow for more|who else|raise your hand|\u{1F447}|\u{261D})/iu;

  /**
   * Text as the model should see it and as its hash is taken. Line structure
   * is kept, because an arrow listicle is a sign and flattening it would hide
   * that; only runs of blank space are squeezed, so that two copies of the
   * same post that differ in spacing share one cached verdict.
   */
  function normalizeText(raw) {
    if (typeof raw !== 'string') return '';
    return raw
      .normalize('NFC')
      .replace(/\r\n?/g, '\n')
      .replace(/[^\S\n]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function bulletLines(text) {
    return text.split('\n').filter((line) => BULLET_LINE.test(line)).length;
  }

  /** Three or more one-line paragraphs in a row: the template's own rhythm. */
  function stackedShortLines(text) {
    let run = 0;
    let best = 0;
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (t && t.length <= 60) best = Math.max(best, ++run);
      else run = 0;
    }
    return best;
  }

  function emDashesPer100Words(text) {
    const words = text.split(/\s+/).filter(Boolean).length || 1;
    return ((text.match(/\u{2014}/gu) || []).length * 100) / words;
  }

  /**
   * Which signs a post shows.
   *
   * @param {string} raw
   * @returns {{suspicious:boolean, hits:string[], text:string}}
   *   `text` is the normalized form: what to hash and what to send.
   */
  function prefilter(raw) {
    const text = normalizeText(raw);
    if (text.length < MIN_CHARS) return { suspicious: false, hits: [], text };

    const hits = [];

    const vocabulary = new Set((text.match(AI_VOCABULARY) || []).map((w) => w.toLowerCase()));
    if (vocabulary.size >= 2) hits.push('ai_vocabulary');
    if (NEGATIVE_PARALLELISM.some((re) => re.test(text))) hits.push('negative_parallelism');
    if (bulletLines(text) >= 3) hits.push('listicle_formatting');
    if (stackedShortLines(text) >= 3) hits.push('stacked_lines');
    if (PUFFERY.test(text)) hits.push('significance_puffery');
    if (PROMOTIONAL_TONE.test(text)) hits.push('promotional_tone');
    if (VAGUE_ATTRIBUTION.test(text)) hits.push('vague_attribution');
    if (ENGAGEMENT_BAIT.test(text)) hits.push('engagement_bait');
    if (emDashesPer100Words(text) >= 3) hits.push('em_dashes');

    // One strong structural tell is enough on its own; the softer ones have to
    // agree with something else, or ordinary enthusiastic writing would trip.
    const strong = hits.includes('negative_parallelism') || hits.includes('listicle_formatting');
    return { suspicious: strong || hits.length >= 2, hits, text };
  }

  globalThis.KillSlopSigns = { normalizeText, prefilter, MIN_CHARS };
})();
