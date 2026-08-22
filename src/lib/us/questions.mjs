/**
 * questions.mjs — the gate's questions. Prompts and hints only, never answers.
 *
 * Plain ESM for the same reason answers.mjs is: `scripts/gate-hash.mjs` runs
 * under a bare `node` and must walk these questions IN THIS ORDER while asking
 * me for the accepted answers, so that answer set N always lines up with
 * question N. If the CLI had its own copy of this list, reordering one file and
 * not the other would silently check every answer against the wrong question —
 * and the only symptom would be a gate that never opens.
 *
 * These prompts are committed to a PUBLIC repo and are therefore readable by
 * anyone. That is by design: the security is that the answers are un-reversible
 * keyed digests, never that the questions are secret. If a prompt would itself
 * be embarrassing to publish, put the whole list in the US_QUESTIONS
 * environment variable instead, which overrides this file wholesale.
 *
 * TO CHANGE THE QUESTIONS
 *   1. edit this list
 *   2. re-run `npm run gate:hash`
 *   3. paste the new US_ANSWERS into Vercel
 * Skipping step 2 or 3 leaves the old answers bound to the new questions.
 *
 * ---------------------------------------------------------------------------
 * THE HINT RULE — a hint is published, so treat it like one
 *
 * Hints live in this file, which is committed to a PUBLIC repository. They are
 * therefore readable by anyone, WITHOUT hitting the server and WITHOUT spending
 * a rate-limited attempt. That makes a careless hint worse than a weak answer.
 *
 * The first draft of this file failed that test badly, in two ways worth naming
 * abstractly rather than quoting: one hint named the public page where the answer
 * could be looked up, and another contained a word from the answer itself. An
 * adversarial review flagged that the questions plus those hints let someone
 * derive the whole answer space offline, without touching the server.
 *
 * (Deliberately paraphrased. Quoting the bad hints here to explain the lesson
 * would have re-published exactly the thing the lesson is about — which is the
 * mistake this comment originally made on its second draft.)
 *
 * So: a hint may narrow the SHAPE of an answer (how many words, what kind of
 * thing, roughly when). It must never name a source where the answer is
 * published, and must never contain a substring of the answer itself. If a hint
 * would help a stranger as much as it helps her, it is not a hint, it is a leak.
 *
 * If you want hints that genuinely trade on shared memory, put the whole list in
 * the US_QUESTIONS environment variable instead, where nothing is published.
 */

/**
 * @typedef {object} Question
 * @property {string} prompt        what she reads
 * @property {[string, string]} hints  released after wrong attempt 1, then 2
 * @property {string} [placeholder] soft format cue, e.g. "a day of the week"
 */

/** @type {Question[]} */
export const DEFAULT_QUESTIONS = [
  /* PLACEHOLDERS. These three are answerable from Sam's PUBLIC portfolio, which
     is exactly why they must be replaced before this is shared. They exist so
     the flow can be exercised end to end, nothing more. `US_GATE_REVIEWED=1`
     is the switch that says a human has replaced them. */
  {
    prompt: 'what day of the week is non-negotiable for me?',
    hints: ['one word.', 'the same one every week, all year.'],
    placeholder: 'a day of the week',
  },
  {
    prompt: 'where do i send people who ask for one good meal?',
    hints: ['four words.', 'you have heard me say it more than once.'],
    placeholder: 'a restaurant',
  },
  {
    prompt: 'what do i order, every single time?',
    hints: ['two words.', 'you already know. you have watched me order it.'],
    placeholder: 'a drink',
  },
];
