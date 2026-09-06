/**
 * test-comments.mts — the conversation under a photograph behaves, from BOTH sides.
 *
 *   npm run test:comments
 *
 * ---------------------------------------------------------------------------
 * WHAT IS ACTUALLY AT RISK, because "a list of strings with authors" sounds safe
 *
 *   1. WHO MAY EDIT WHAT. `mayChange()` is the only authorisation rule in the
 *      feature. If it is wrong in the permissive direction, either of them can
 *      rewrite the other's words after they have been read — which is the one thing
 *      a record of a conversation must not allow. Tested from BOTH sides, because
 *      `CLAUDE.md` says an implementation that swaps "mine" and "theirs" passes every
 *      assertion when only one viewer is hard-coded.
 *   2. ORDER. A conversation is read top to bottom. An unstable sort reorders it
 *      between renders, and two comments CAN share a millisecond.
 *   3. THE CAPS REFUSE RATHER THAN PRUNE. Nothing may ever be auto-deleted to make
 *      room — the lesson marks.ts learned expensively.
 *   4. THE LENGTH REFUSAL MUST BE REACHABLE. Measuring the truncated text instead of
 *      the tidied text makes the 413 unreachable, which is the exact bug
 *      together.ts's `tidyAnswer`/`normalizeAnswer` split exists to prevent.
 *   5. NOTHING HERE MAY THROW. It parses values a phone produced and a hand-edit may
 *      have mangled, and one bad record must cost one comment rather than the thread.
 *
 * NOTHING IN HERE TOUCHES UPSTASH, R2 OR THE NETWORK. comment-thread.ts imports
 * nothing but a type, which is why this suite can exist at all — the store lives in
 * comments.ts and is deliberately not under test here.
 */
import { readFileSync } from 'node:fs';
import {
  TEXT_MAX,
  THREAD_MAX,
  addRefusal,
  countLabel,
  isCommentId,
  mayChange,
  normalizeComment,
  parseComment,
  thread,
  type Comment,
} from '../src/lib/us/comment-thread.ts';

let pass = 0,
  fail = 0;
const is = (n: string, c: boolean, got?: unknown) => {
  c ? pass++ : fail++;
  console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${c ? '' : '  got ' + JSON.stringify(got)}`);
};

/* Ids are real UUID shapes but obviously synthetic, and no comment text below
   resembles anything either of them would write. THIS REPOSITORY IS PUBLIC and the
   recorded way private data reaches it is a future session reaching for a
   "realistic" fixture — see CLAUDE.md. Nothing here is realistic on purpose. */
const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const ID_C = '33333333-3333-4333-8333-333333333333';

const c = (id: string, by: 'her' | 'him', at: number, text = 'xxxx', editedAt = 0): Comment => ({
  id,
  by,
  text,
  at,
  editedAt,
});

console.log('\n  --- 1. only the author may edit or delete, from BOTH sides ---');
{
  const hers = c(ID_A, 'her', 1000);
  const his = c(ID_B, 'him', 2000);

  is('she may change her own', mayChange(hers, 'her'));
  is('he may NOT change hers', !mayChange(hers, 'him'));
  is('he may change his own', mayChange(his, 'him'));
  is('she may NOT change his', !mayChange(his, 'her'));

  /* The absent cases, which are the ones a store lookup actually returns when an id
     selects nothing. A permissive answer here would let a made-up id authorise. */
  is('null is not changeable by her', !mayChange(null, 'her'));
  is('null is not changeable by him', !mayChange(null, 'him'));
  is('undefined is not changeable', !mayChange(undefined, 'her'));
}

console.log('\n  --- 2. the thread reads oldest first, and the order is total ---');
{
  const out = thread({ [ID_B]: c(ID_B, 'him', 3000), [ID_A]: c(ID_A, 'her', 1000) });
  is('oldest first', out.map((x) => x.id).join() === `${ID_A},${ID_B}`, out.map((x) => x.id));

  /* SAME MILLISECOND. Two sends in one tick, or both of them at once. Without the id
     tiebreak this is unstable and a conversation reorders between renders. */
  const tie = { [ID_C]: c(ID_C, 'her', 5000), [ID_A]: c(ID_A, 'him', 5000), [ID_B]: c(ID_B, 'her', 5000) };
  const once = thread(tie).map((x) => x.id).join();
  const twice = thread(tie).map((x) => x.id).join();
  is('a millisecond tie still has ONE order', once === twice, [once, twice]);
  is('and it is the id order', once === `${ID_A},${ID_B},${ID_C}`, once);

  is('an empty thread is an empty array', thread({}).length === 0);
}

console.log('\n  --- 3. the caps refuse; they never prune ---');
{
  const full: Record<string, Comment> = {};
  for (let i = 0; i < THREAD_MAX; i += 1) {
    const id = `4${String(i).padStart(7, '0')}-4444-4444-8444-444444444444`;
    full[id] = c(id, i % 2 ? 'her' : 'him', 1000 + i);
  }
  /* addRefusal TAKES A COUNT, not the thread. The store passes HLEN — see the
     signature's own comment on why fetching the whole conversation to take
     `.length` of it was the thing worth removing. */
  const held = Object.keys(full).length;
  is(`a thread of ${THREAD_MAX} is refused a new one`, addRefusal(held, 'xxxx') === 'thread-full', addRefusal(held, 'xxxx'));
  /* THE POINT OF THE ASSERTION ABOVE: refusing must not have removed anything. */
  is('and refusing did not delete a single one', Object.keys(full).length === THREAD_MAX, Object.keys(full).length);
  is('one short of the cap is accepted', addRefusal(THREAD_MAX - 1, 'xxxx') === null);
  /* THE BOUNDARY IS `>=`, so exactly the cap refuses and one under does not. Off by
     one here means either an 81st comment or a thread that stops at 79. */
  is('exactly the cap refuses', addRefusal(THREAD_MAX, 'xxxx') === 'thread-full');
  is('an empty thread accepts', addRefusal(0, 'xxxx') === null);

  is('an empty comment is refused as empty', addRefusal(0, '   ') === 'empty', addRefusal(0, '   '));
  is('a non-string is refused as empty', addRefusal(0, null) === 'empty');
  /* ORDER OF REASONS: empty beats full, because "the thread is full" is useless
     advice about a comment that does not exist. */
  is('empty beats thread-full', addRefusal(held, '') === 'empty', addRefusal(held, ''));

  /* THE LENGTH REFUSAL MUST BE REACHABLE. addRefusal measures the TIDIED text; if it
     measured the normalised (truncated) text this could never fire. */
  const long = 'x'.repeat(TEXT_MAX + 1);
  is('one over the cap is refused as too-long', addRefusal(0, long) === 'too-long', addRefusal(0, long));
  is('exactly the cap is accepted', addRefusal(0, 'x'.repeat(TEXT_MAX)) === null);
  is('and too-long beats thread-full', addRefusal(held, long) === 'too-long', addRefusal(held, long));
  /* AN UNREADABLE COUNT MUST REFUSE, NOT LET EVERYTHING THROUGH. comments.ts maps a
     malformed HLEN to MAX_SAFE_INTEGER for exactly this, so the fail direction is
     "this one is full" and never an unbounded thread. */
  is('an absurd count still refuses', addRefusal(Number.MAX_SAFE_INTEGER, 'xxxx') === 'thread-full');
}

console.log('\n  --- 4. whitespace: paragraphs survive, padding does not ---');
{
  is('leading and trailing space goes', normalizeComment('  hi  ') === 'hi', normalizeComment('  hi  '));
  is('a run of spaces collapses', normalizeComment('a    b') === 'a b', normalizeComment('a    b'));
  /* DELIBERATELY UNLIKE a list item, which flattens newlines: prose keeps its
     shape. Somebody who wrote two paragraphs meant two paragraphs. */
  is('one blank line survives as a paragraph break',
    normalizeComment('a\n\nb') === 'a\n\nb', JSON.stringify(normalizeComment('a\n\nb')));
  is('a single newline survives', normalizeComment('a\nb') === 'a\nb', JSON.stringify(normalizeComment('a\nb')));
  is('leaning on return collapses to one blank line',
    normalizeComment('a\n\n\n\n\nb') === 'a\n\nb', JSON.stringify(normalizeComment('a\n\n\n\n\nb')));
  is('CRLF is normalised', normalizeComment('a\r\n\r\nb') === 'a\n\nb', JSON.stringify(normalizeComment('a\r\n\r\nb')));
  is('trailing spaces on a line go, so they cannot defeat the length check',
    normalizeComment('a   \nb') === 'a\nb', JSON.stringify(normalizeComment('a   \nb')));
  is('over the cap is cut to the cap', normalizeComment('x'.repeat(TEXT_MAX + 50)).length <= TEXT_MAX,
    normalizeComment('x'.repeat(TEXT_MAX + 50)).length);

  /* NO HALF AN EMOJI. slice() counts UTF-16 units, so a naive cut between the halves
     of a surrogate pair leaves a lone surrogate that renders as a black diamond. */
  const emoji = 'a'.repeat(TEXT_MAX - 1) + '😀';
  const cut = normalizeComment(emoji);
  is('a cut never leaves half a surrogate pair',
    !/[\uD800-\uDBFF]$/.test(cut), cut.slice(-4));
}

console.log('\n  --- 5. parsing is total, and a bad author is not guessed into power ---');
{
  const good = JSON.stringify({ id: ID_A, by: 'him', text: 'xxxx', at: 1234, editedAt: 0 });
  const p = parseComment(good);
  is('a good record parses', p !== null && p.id === ID_A && p.by === 'him', p);
  is('and keeps its timestamp', p?.at === 1234, p?.at);

  is('an object works as well as a string', parseComment({ id: ID_A, by: 'her', text: 'x', at: 1 })?.by === 'her');
  is('malformed JSON is null, not a throw', parseComment('{nope') === null);
  is('no id is null', parseComment(JSON.stringify({ by: 'her', text: 'x' })) === null);
  is('a bad id SHAPE is null', parseComment(JSON.stringify({ id: 'nope', by: 'her', text: 'x' })) === null);
  is('no text is null', parseComment(JSON.stringify({ id: ID_A, by: 'her', text: '   ' })) === null);
  is('null is null', parseComment(null) === null);
  is('a number is null', parseComment(42) === null);

  /* A nonsense `at` must not become NaN or Infinity: both survive arithmetic and
     JSON.stringify writes Infinity as null, which reads back as 0 later. */
  is('Infinity in `at` becomes 0', parseComment(JSON.stringify({ id: ID_A, by: 'her', text: 'x', at: 1e999 }))?.at === 0);
  is('a negative `at` becomes 0', parseComment(JSON.stringify({ id: ID_A, by: 'her', text: 'x', at: -5 }))?.at === 0);
  is('a string `at` is read', parseComment(JSON.stringify({ id: ID_A, by: 'her', text: 'x', at: '99' }))?.at === 99);
  is('editedAt defaults to 0', parseComment(JSON.stringify({ id: ID_A, by: 'her', text: 'x' }))?.editedAt === 0);

  is('isCommentId accepts a real uuid', isCommentId(ID_A));
  is('and refuses a path', !isCommentId('../../.env'));
  is('and refuses a number', !isCommentId(1));
  is('and refuses an almost-uuid', !isCommentId(ID_A.slice(0, -1)));
}

console.log('\n  --- 6. the count reads like English, and zero renders nothing ---');
{
  is('zero is the empty string, so nothing renders', countLabel(0) === '', countLabel(0));
  is('negative is also nothing', countLabel(-3) === '', countLabel(-3));
  is('one is singular', countLabel(1) === '1 comment', countLabel(1));
  is('two is plural', countLabel(2) === '2 comments', countLabel(2));
  is('eighty is plural', countLabel(80) === '80 comments', countLabel(80));
}

console.log('\n  --- 7. the module stays loadable by bare node ---');
{
  /* One runtime import and this whole suite stops running, which is exactly why
     together.ts's equivalents have never been tested. A TYPE import is erased and is
     therefore allowed; anything else is not. */
  const src = readFileSync(new URL('../src/lib/us/comment-thread.ts', import.meta.url), 'utf8');
  const imports = (src.match(/^\s*import\s.+$/gm) ?? []).filter((l) => !/^\s*import type\s/.test(l));
  is('comment-thread.ts has no RUNTIME imports', imports.length === 0, imports);
}

console.log(`\n  ${fail ? 'FAILED' : 'all good'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
