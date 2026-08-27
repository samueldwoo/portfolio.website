/* ============================================================================
   WHAT TO CALL THE TWO OF THEM, FROM THE READER'S SIDE

   ONE MODULE BECAUSE THERE WERE FOUR, AND THEY DISAGREED

   Every page had grown its own version of this — `whoWord()` in day.astro,
   a `whoWord` record plus `theirWord` in today.astro, `byWord()` alongside
   `themWord` and `themPossessive` in index.astro — and they had drifted into
   three different answers to the same question:

     day.astro     her → her name, him → 'Sam'      (right)
     today.astro   her → her name, him → 'Sam'      (right)
     index.astro   her → 'she',    him → 'he'       (a pronoun, on the
                                                     questions block only)

   So the hub told him "she has answered" about the person whose name is in
   the environment variable two pages away, and told her "he said" about Sam.
   Nothing was broken; the words were just colder than everywhere else, and
   only on the one block where the two of them actually talk to each other.

   THE RULE, AND IT IS THE WHOLE MODULE: the reader is 'you'. The other one
   gets their NAME. A name is what you call someone you know, and a pronoun in
   its place reads like a system describing a user — which is exactly what the
   byline fix in index.astro concluded, one block too late to reach the rest.

   NAMES ARE ASYMMETRIC ON PURPOSE. Hers lives in US_HER_NAME because this repo
   is public and her name is hers. His is the literal 'Sam' because there is no
   US_HIS_NAME and inventing one would be a variable that must be set and
   redeployed before the copy is even correct — for the one reader who already
   knows his name.

   PURE, AND DEPENDENCY-FREE ON PURPOSE. The `Who` import is type-only and
   therefore erased, so bare `node` can import this file and test it — the same
   trick frame-keys.ts uses, and the reason it has a test at all. Reading the
   environment here instead of taking the name as an argument would have made it
   untestable without a build step.
   ========================================================================= */

import type { Who } from './together';

/* THREE FORMS, BECAUSE ENGLISH HAS THREE AND THE FALLBACKS DIVERGE

   With the name SET all three are the same string plus an apostrophe, and it is
   tempting to ship one function. With it UNSET they are three different words:

                    reader   her (unset)   him
     of()           you      she           Sam        "___ answered"
     possessiveOf() yours    hers          Sam’s      "so it stays ___"
     attributiveOf() your    her           Sam’s      "I can’t see ___ side"

   So a single accessor with a caller-chosen default — HER_NAME_OR's whole
   design — can only ever be right for one of the three. That is why this module
   takes the RAW name and owns all three fallbacks itself. today.astro had
   already hit this the hard way: it built `${theirWord}’s side` by hand, which
   reads "I can't see she's side" the moment the variable is missing. */

/** The words for one reader. Built once per render by `whoWords()`. */
export interface WhoWords {
  /** The subject form. 'you' when the subject IS the reader. */
  of(subject: Who): string;
  /** Independent possessive — the form that ENDS a clause: "so it stays ___". */
  possessiveOf(subject: Who): string;
  /** Attributive possessive — the form that MODIFIES a noun: "___ side". */
  attributiveOf(subject: Who): string;
  /** The other person, named. The common case, so it is a property not a call. */
  them: string;
  /** The other person's independent possessive. */
  themPossessive: string;
  /** The other person's attributive possessive. */
  themAttributive: string;
}

/**
 * Build the words for one reader.
 *
 * `herName` is the raw variable — undefined when it is not configured, NOT
 * HER_NAME()'s 'you'. That fallback is right where the copy addresses her
 * directly and actively wrong here: "you have answered" on his screen would
 * credit him with her answer, which is the failure this module is named after.
 */
export function whoWords(viewer: Who, herName: string | undefined): WhoWords {
  const of = (subject: Who): string => {
    if (subject === viewer) return 'you';
    return subject === 'her' ? (herName || 'she') : 'Sam';
  };

  // A curly apostrophe in both, because every other possessive in this wing has
  // one and a name is the last place to switch typefaces mid-sentence.
  const possessiveOf = (subject: Who): string => {
    if (subject === viewer) return 'yours';
    if (subject === 'her') return herName ? `${herName}’s` : 'hers';
    return 'Sam’s';
  };

  const attributiveOf = (subject: Who): string => {
    if (subject === viewer) return 'your';
    if (subject === 'her') return herName ? `${herName}’s` : 'her';
    return 'Sam’s';
  };

  const them: Who = viewer === 'her' ? 'him' : 'her';

  return {
    of,
    possessiveOf,
    attributiveOf,
    them: of(them),
    themPossessive: possessiveOf(them),
    themAttributive: attributiveOf(them),
  };
}

/**
 * Sentence-initial form of a word from `of()`.
 *
 * A name is already capitalised and a fallback pronoun is not, so copy that
 * starts a sentence with one needs this rather than a CSS `::first-letter` or a
 * hand-written `charAt(0).toUpperCase()` at each site. Kept here so the two
 * cases can never be capitalised differently on two pages.
 */
export function sentenceCase(word: string): string {
  return word ? word.charAt(0).toUpperCase() + word.slice(1) : word;
}
