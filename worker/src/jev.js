/**
 * The writing check: TypeSafe's Jev model, asked how strongly a post reads as
 * LLM-written.
 *
 * This is the only place in the project that asks anything of a model, and the
 * only reason the worker holds a third-party key. It lives here and not in the
 * extension because the extension ships unbundled and readable: a key in it
 * would be a published key.
 *
 * Jev is not a text generator. It answers typed questions about the state it
 * is given and returns calibrated probabilities, so the answer is a number
 * this code can threshold rather than prose something has to parse.
 *
 * Two questions, asked together. They are evaluated in parallel against the
 * same post, so the second costs latency nothing and gives the hidden-post
 * card something concrete to say. Measured on 2026-09-18: about 835 input
 * tokens a post, roughly $0.035 per thousand posts.
 *
 * One post per request, deliberately. Batching ten posts into one state and
 * asking per-index questions was twice as cheap and measurably worse: a human
 * post scored 2.57 at confidence 0.15 in a batch against 0.02 at 0.99 asked on
 * its own. That matches TypeSafe's own documented weakness at indirection and
 * at state full of content irrelevant to the question.
 */

const API = 'https://api.typesafe.ai/v1/systemone';
const MODEL = 'jev-latest';

/** Longer than any real post on either platform, and a bound on what we spend. */
export const MAX_TEXT_CHARS = 2000;

/**
 * The rubric is Wikipedia's "Signs of AI writing" (CC BY-SA 4.0, see
 * ATTRIBUTION.md), reduced to the signs that survive in a few hundred
 * characters.
 *
 * The last sentence of the instructions is load-bearing and must not be
 * dropped. Without it the check reads unusual English as machine English, and
 * a filter that hides non-native speakers for writing like non-native speakers
 * would be exactly the public accusation this project refuses to make. With
 * it, both non-native samples in the 2026-09-18 measurement scored below 0.9.
 */
const QUESTIONS = {
  slop_level: {
    type: 'score',
    instructions:
      "How strongly does this social media post exhibit the recognizable patterns of LLM-generated writing catalogued in Wikipedia's 'Signs of AI writing' (AI vocabulary, negative parallelism, rule-of-three, arrow or numbered listicle templates, significance puffery, vague attribution, engagement bait)? Judge the writing patterns only. Non-native English, awkward grammar, translation artefacts, typos, and unusual phrasing are signs of a HUMAN writer, not of AI.",
    criteria: [
      'Unmistakably human: idiosyncratic voice, typos, slang, translation artefacts, or concrete first-hand detail.',
      'Mostly human; at most one mild generic phrase.',
      'Ambiguous: polished and somewhat generic, but plausibly a careful or professional human writer.',
      'Several clear tells from the rubric.',
      'Saturated with tells; near-certainly LLM-generated or template-generated engagement content.',
    ],
  },
  top_signal: {
    type: 'choice',
    instructions:
      "Which single pattern from the Wikipedia 'Signs of AI writing' rubric is the strongest evidence in this post?",
    criteria: {
      ai_vocabulary:
        'delve, intricate, underscore, pivotal, crucial, leverage, unlock, landscape, testament, realm, navigate.',
      negative_parallelism: "'Not X, but Y' / 'It is not about X. It is about Y.'",
      rule_of_three: 'Triadic lists used as a rhetorical crutch.',
      significance_puffery: 'Hollow importance: game-changer, pivotal moment, marks a shift.',
      listicle_formatting:
        'Arrow bullets, numbered takeaways, stacked one-line paragraphs as a template.',
      promotional_tone: 'Influencer register: thrilled to announce, humbled, journey, vibrant.',
      engagement_bait: "Solicits replies, reposts, comments, 'which one are you?'.",
      vague_attribution: 'Weasel sourcing: studies show, experts agree, industry reports.',
      none: 'No rubric signal is clearly present.',
    },
  },
};

/** Answers we will act on. Anything else means the service changed under us. */
function readAnswers(body) {
  const level = body?.answers?.slop_level;
  const signal = body?.answers?.top_signal;
  if (!level || level.type !== 'score' || typeof level.score !== 'number') return null;
  if (!Number.isFinite(level.score) || level.score < 0 || level.score > 4) return null;
  return {
    score: level.score,
    conf: typeof level.confidence === 'number' ? level.confidence : null,
    signal: typeof signal?.choice === 'string' ? signal.choice.slice(0, 32) : null,
    model: typeof body.model === 'string' ? body.model.slice(0, 32) : MODEL,
    tokens: Number(body?.usage?.input_tokens) || 0,
  };
}

/**
 * Ask Jev about one post.
 *
 * Returns null rather than throwing on anything that is not a clean answer:
 * the writing check is the last tier, so a failure here means the post is
 * simply not decided, exactly as if the check were switched off.
 *
 * @param {string} text  normalized post text, already length-checked
 * @param {object} env   needs TYPESAFE_API_KEY
 * @returns {Promise<{score:number, conf:number|null, signal:string|null, model:string, tokens:number}|null>}
 */
export async function askJev(text, env) {
  if (!env?.TYPESAFE_API_KEY) return null;
  if (typeof text !== 'string' || !text || text.length > MAX_TEXT_CHARS) return null;

  const payload = JSON.stringify({ state: { post: text }, model: MODEL, questions: QUESTIONS });

  // One retry, because 429 and 529 are the two TypeSafe documents as worth
  // retrying. Anything else is answered or broken, and retrying it just costs.
  for (let attempt = 0; attempt < 2; attempt++) {
    let res;
    try {
      res = await fetch(API, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.TYPESAFE_API_KEY}`,
          'content-type': 'application/json',
        },
        body: payload,
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      return null;
    }
    if (res.status === 429 || res.status === 529) {
      await res.body?.cancel().catch(() => {});
      if (attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        continue;
      }
      return null;
    }
    if (!res.ok) return null;
    try {
      return readAnswers(await res.json());
    } catch {
      return null;
    }
  }
  return null;
}

export const __testing = { QUESTIONS, readAnswers, API, MODEL };
