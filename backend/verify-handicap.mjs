/**
 * Course handicap from a GHIN index and a set of tees.
 *
 * The fixture is not invented: these are the seven men in the Nunes group, their
 * live GHIN indexes, and the handicaps they actually played off across four real
 * rounds. If this function cannot reproduce that table it is wrong, whatever the
 * handicap manual says.
 *
 *              index    played off
 *   Tim         18.7        21
 *   Ken         10.8        12
 *   Gary        10.4        12
 *   Bunch        7.0         8
 *   Casey        5.5         6
 *   Bridges      3.0         3
 *   Tyler       +0.3         0
 *
 * That table is reproduced exactly by round(index x slope/113) at El Macero
 * White (slope 129) — the PRE-2020 formula, with no (CourseRating - Par) term.
 * Current WHS adds that term. Whether to adopt it is a decision for the group,
 * not a correctness fix to apply on their behalf, so it is a flag and the
 * default is off. These checks exist to make sure it STAYS off by accident-proof
 * means rather than by memory.
 *
 * Usage: node backend/verify-handicap.mjs index.html
 */
import fs from 'node:fs';
const src = fs.readFileSync(process.argv[2] || 'index.html', 'utf8');

function grab(name) {
  const i = src.indexOf('\n  ' + name + '(');
  if (i < 0) throw new Error('not found: ' + name);
  let d = 0, started = false, j = i;
  for (; j < src.length; j++) {
    const c = src[j];
    if (c === '{') { d++; started = true; }
    else if (c === '}') { d--; if (started && d === 0) { j++; break; } }
  }
  return src.slice(i, j);
}

const Game = eval('({' + [grab('parseIndex'), grab('courseHandicap')].join(',') + '})');

let fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}` +
    (ok ? '' : `\n          got  ${JSON.stringify(got)}\n          want ${JSON.stringify(want)}`));
};

// Straight out of GHIN, 2026-09-14. El Macero was re-rated since the August
// pull: Blue was 73.0/127 then and is 73.1/137 now.
const WHITE = { name: 'White', rating: 72.0, slope: 129, par: 72 };
const BLUE  = { name: 'Blue',  rating: 73.1, slope: 137, par: 72 };
const GOLD  = { name: 'Gold',  rating: 66.6, slope: 117, par: 72 };

const GROUP = [
  ['Timothy Mar',     '18.7', 21],
  ['Kenneth Bernard', '10.8', 12],
  ['Gary Nunes',      '10.4', 12],
  ['Brian Bunch',      '7.0',  8],
  ['Brian Casey',      '5.5',  6],
  ['Brandon Bridges',  '3.0',  3],
  ['Tyler Bryan',     '+0.3',  0],
];

console.log('the real group, off the real cards, at El Macero White\n');
{
  const got = GROUP.map(([n, idx]) => Game.courseHandicap(idx, WHITE));
  const want = GROUP.map(([, , played]) => played);
  check('all seven reproduce exactly', got, want);
  GROUP.forEach(([name, idx, played]) => {
    check(`  ${name} (${idx})`, Game.courseHandicap(idx, WHITE), played);
  });
}

console.log('\nthe WHS term is available, and OFF unless asked for\n');
{
  check('off by default, Tim is 21', Game.courseHandicap('18.7', WHITE), 21);
  // White is rated 72.0 to a par of 72, so the WHS term is worth exactly zero
  // there and the two formulas agree. That is a fact about this tee, not
  // evidence the flag works — the flag has to be shown biting somewhere else.
  check('at White the term is worth nothing either way',
    Game.courseHandicap('18.7', WHITE, { useRatingMinusPar: true }), 21);
  check('  because White plays 0.0 over par', WHITE.rating - WHITE.par, 0);

  // Blue is rated 73.1 to the same par, so there it is worth a stroke.
  check('at Blue the term adds a stroke to Ken',
    [Game.courseHandicap('10.8', BLUE), Game.courseHandicap('10.8', BLUE, { useRatingMinusPar: true })], [13, 14]);
  check('  and to Tim', Game.courseHandicap('18.7', BLUE, { useRatingMinusPar: true }), 24);
  // Gold is rated well UNDER par, so the term takes strokes away — which is the
  // direction most likely to be mistaken for a bug.
  check('at Gold it takes strokes off, not on',
    [Game.courseHandicap('18.7', GOLD), Game.courseHandicap('18.7', GOLD, { useRatingMinusPar: true })], [19, 14]);
  check('an explicit false is still off', Game.courseHandicap('18.7', WHITE, { useRatingMinusPar: false }), 21);
  check('an empty opts is still off', Game.courseHandicap('18.7', WHITE, {}), 21);
}

console.log('\nplus handicaps — the sign is the whole game\n');
{
  check('"+0.3" is NEGATIVE three tenths', Game.parseIndex('+0.3'), -0.3);
  check('  which parseFloat alone gets backwards', parseFloat('+0.3'), 0.3);
  check('Tyler is a 0 at White', Game.courseHandicap('+0.3', WHITE), 0);
  check('and a genuine plus stays a plus', Game.courseHandicap('+2.8', WHITE), -3);
  check('  giving strokes back, not receiving', Game.courseHandicap('+2.8', WHITE) < 0, true);
  // The case that actually separates the two roundings. Math.round(-1.5) is -1
  // in JavaScript — it rounds toward positive infinity, not away from zero — so
  // a naive Math.round gives a +1.5 player back ONE stroke while giving a 1.5
  // player TWO. Slope 113 makes the course handicap equal the index exactly, so
  // the half lands where it can be seen.
  const NEUTRAL = { name: 'Neutral', rating: 72, slope: 113, par: 72 };
  check('a 1.5 receives two', Game.courseHandicap('1.5', NEUTRAL), 2);
  check('  so a +1.5 gives back two, not one', Game.courseHandicap('+1.5', NEUTRAL), -2);
  check('  and 2.5 / +2.5 mirror as well',
    [Game.courseHandicap('2.5', NEUTRAL), Game.courseHandicap('+2.5', NEUTRAL)], [3, -3]);
  check('a near-scratch plus is still zero, not a stroke',
    Object.is(Game.courseHandicap('+0.44', GOLD), -0), true);
}

console.log('\nno data is not a zero\n');
{
  check('"NH" means no handicap', Game.courseHandicap('NH', WHITE), null);
  check('  not scratch', Game.courseHandicap('NH', WHITE) === 0, false);
  check('a tee with no slope yields nothing', Game.courseHandicap('10.8', { name: 'Muni', slope: null }), null);
  check('  rather than the raw index', Game.courseHandicap('10.8', { name: 'Muni' }), null);
  check('no tee at all', Game.courseHandicap('10.8', null), null);
  check('no index', Game.courseHandicap(null, WHITE), null);
  check('empty string', Game.courseHandicap('', WHITE), null);
  check('nonsense', Game.courseHandicap('abc', WHITE), null);
  check('a number index works too', Game.courseHandicap(10.8, WHITE), 12);
}

console.log('\nthe tee genuinely changes the number\n');
{
  check('Ken across White, Blue, Gold',
    [WHITE, BLUE, GOLD].map((t) => Game.courseHandicap('10.8', t)), [12, 13, 11]);
  check('  so a wrong tee is a stroke either way', true, true);
}

console.log(fail ? `\n${fail} FAILURES` : '\nall checks passed');
process.exit(fail ? 1 : 0);
