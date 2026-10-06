/**
 * KP rules: extracts the SHIPPED computeKP out of index.html and runs it against
 * the real hole that exposed the problem — Sep 19 2026, El Macero, last par 3,
 * Gary closest and three-putting for bogey.
 *
 * The rule being asserted (Brian, 2026-09-19):
 *   - the ranking is closest-to-pin order of everyone who hit the green
 *   - per game, the closest player IN THAT GAME decides the hole and nobody else
 *   - the bar is GROSS par; strokes do not buy a KP
 *   - if he misses, there is no KP and the value carries to the next par 3
 *   - a carry still dangling after the last par 3 dies, and kills sweeps/quads
 *
 * Usage: node backend/verify-kp.mjs index.html
 */
import fs from 'node:fs';
const src = fs.readFileSync(process.argv[2] || 'index.html', 'utf8');

// ---------------------------------------------------------------- extraction
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

const PAR = [4,5,3,4,5,4,3,4,4, 4,4,3,4,4,5,3,4,5];   // El Macero
const PAR3S = [2, 6, 11, 15];                          // holes 3, 7, 12, 16

globalThis.State = { data: { course: { par: PAR }, startingHole: 0, games: [] } };

const Game = eval('({' + [grab('computeKP'), grab('computeKPThroughHole'), grab('kpTeamSplit')].join(',') + `,
  getPar3Holes() { return ${JSON.stringify(PAR3S)}; },
  courseHole(pos) { return pos; },
  strokes(g, pid, hole) { return (g.strokesCount && g.strokesCount[pid]) || 0; }
})`);

// -------------------------------------------------------------------- fixture
// Five players. Gary is the 21-handicap who hits it stiff and three-putts.
const mkGame = (teamA, teamB, kpData, gross, strokesCount) => ({
  teamA, teamB, kpData, gross,
  strokesCount: strokesCount || {},
  junkValue: { front: 2, back: 2 },
  quadsConfirmed: {},
});

// scores on the four par 3s only (index = hole); everything else filled so
// allPar3sScored is satisfied
const card = (vals) => { const a = new Array(18).fill(null); PAR3S.forEach((h, i) => a[h] = vals[i]); return a; };

//                       h3 h7 h12 h16
const GROSS = {
  tyler: card([3, 3, 3, 3]),
  ken:   card([3, 3, 3, 3]),
  casey: card([3, 3, 3, 3]),
  bunch: card([3, 3, 3, 3]),
  gary:  card([3, 3, 3, 4]),   // <- the three-putt on the last par 3
};

let fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${ok ? '' : `\n          got  ${JSON.stringify(got)}\n          want ${JSON.stringify(want)}`}`);
};

// ------------------------------------------------------------------- the case
console.log("Saturday's hole — Gary closest on the last par 3, misses gross par\n");

// Master ranking, shared across games: Gary closest, then Casey.
const ranking16 = { ranking: ['gary', 'casey'] };
const kp = new Array(18).fill(null);
PAR3S.slice(0, 3).forEach(h => kp[h] = { ranking: ['tyler'] });  // Tyler wins the first three
kp[15] = ranking16;

// Game 1 contains Gary. His miss kills the hole.
const g1 = mkGame(['tyler','ken'], ['gary','bunch'], kp, GROSS);
const r1 = Game.computeKP(g1);
check('game WITH Gary: last par 3 has no winner', r1.results[3].winner, null);
check('game WITH Gary: it carries', r1.results[3].carried, true);
check('game WITH Gary: no sweep despite Tyler/Ken winning the first three', r1.hasSweeps, false);
check('game WITH Gary: no quads prompt', r1.hasQuads, false);
check('game WITH Gary: Tyler/Ken still banked the first three', [r1.teamAKPs, r1.teamBKPs], [3, 0]);

// Game 2 does NOT contain Gary. Casey is the closest man in it and made par.
const g2 = mkGame(['tyler','ken'], ['casey','bunch'], kp, GROSS);
const r2 = Game.computeKP(g2);
check('game WITHOUT Gary: Casey is the closest man in it, and wins', r2.results[3].winner, 'casey');
check('game WITHOUT Gary: it is not a carry', r2.results[3].carried, false);
check('game WITHOUT Gary: so no sweep either (both teams scored)', r2.hasSweeps, false);

console.log('\nThe closest man decides — we never walk past him\n');

// Gary closest and missing, Casey second and making par, BOTH in the same game.
const g3 = mkGame(['tyler','ken'], ['gary','casey'], kp, GROSS);
const r3 = Game.computeKP(g3);
check('closest misses, next-closest made par, same game -> still no KP', r3.results[3].winner, null);
check('  and it carries rather than passing along', r3.results[3].carried, true);

console.log('\nGross par, not net — strokes do not buy a KP\n');

// Gary gets a shot on hole 16 (stroke index would give him one). Net par, gross bogey.
const g4 = mkGame(['tyler','ken'], ['gary','bunch'], kp, GROSS, { gary: 18 });
const r4 = Game.computeKP(g4);
check('a stroke does not rescue a gross bogey', r4.results[3].winner, null);
check('  so still no sweep', r4.hasSweeps, false);

console.log('\nCarries and sweeps still behave\n');

// Gary converts: Tyler/Ken win 1-3, Gary wins the last -> both teams score, no sweep.
const GROSS_OK = JSON.parse(JSON.stringify(GROSS));
GROSS_OK.gary[15] = 3;
const g5 = mkGame(['tyler','ken'], ['gary','bunch'], kp, GROSS_OK);
const r5 = Game.computeKP(g5);
check('Gary converts -> he wins the last KP', r5.results[3].winner, 'gary');
check('  both teams scored, so no sweep', r5.hasSweeps, false);

// Tyler wins all four -> a real sweep, which must still be reported.
const kpAll = new Array(18).fill(null);
PAR3S.forEach(h => kpAll[h] = { ranking: ['tyler'] });
const g6 = mkGame(['tyler','ken'], ['gary','bunch'], kpAll, GROSS);
const r6 = Game.computeKP(g6);
check('genuine sweep is still declared', [r6.hasSweeps, r6.sweepsTeam], [true, 'A']);
check('  and it doubles the KP value', r6.sweepsBonus, r6.totalKPValue);

// Nobody on the green on hole 3 -> carries into hole 7, worth double there.
const kpCarry = new Array(18).fill(null);
kpCarry[2] = null;                              // nobody hit the green
[6, 11, 15].forEach(h => kpCarry[h] = { ranking: ['tyler'] });
const g7 = mkGame(['tyler','ken'], ['gary','bunch'], kpCarry, GROSS);
const r7 = Game.computeKP(g7);
check('empty hole carries', r7.results[0].carried, true);
check('  next win collects both', r7.results[1].value, 4);

// Gary closest on the LAST par 3 and missing, with Tyler having swept 1-3:
// the dangling carry must kill the sweep. (Already covered by r1, restated as
// the regression this whole thing exists to prevent.)
check('dangling carry on the last par 3 kills the sweep', r1.hasSweeps, false);

/**
 * Splitting the KP bet into holes / sweeps / quads.
 *
 * The parts must add back to the single figure that was settled before the
 * split existed, to the cent — this is a reporting change, not a rules change,
 * and a rounding difference here would quietly move real money.
 *
 * It also matters which way up they are. The sweep bonus matches the hole
 * money and the quad bonus matches holes plus sweep, so a quadded round pays
 * FOUR times the par 3s. Showing that as one number is what made the 7.4
 * sweeps bug survive as long as it did.
 */
console.log('\nsplitting KP from its bonuses\n');
{
  // The old expression, kept verbatim as the oracle.
  const before = (kp, szA, szB) => {
    if (kp.hasSweeps || kp.hasQuads) {
      const signA = kp.sweepsTeam === 'A' ? 1 : -1;
      return signA * kp.grandTotal * (kp.sweepsTeam === 'A' ? szB : szA);
    }
    if (kp.netA > 0) return kp.netA * szB;
    if (kp.netA < 0) return kp.netA * szA;
    return 0;
  };

  // Team A sweeps and quads all four par 3s at $4: holes 16, sweep 16, quad 32.
  const swept = { hasSweeps: true, hasQuads: true, sweepsTeam: 'A',
                  totalKPValue: 16, sweepsBonus: 16, quadsBonus: 32, grandTotal: 64, netA: 16 };
  const s1 = Game.kpTeamSplit(swept, 2, 2);
  check('holes, sweep and quad are separate', [s1.base, s1.sweeps, s1.quads], [32, 32, 64]);
  check('  and add back to what was settled before', s1.total, before(swept, 2, 2));
  check('  the bonuses are the larger half', Math.abs(s1.sweeps + s1.quads) > Math.abs(s1.base), true);

  // Same round from the losing side.
  const sweptB = { ...swept, sweepsTeam: 'B' };
  const s2 = Game.kpTeamSplit(sweptB, 2, 2);
  check('a sweep the other way is negative to A', s2.total < 0, true);
  check('  and still reconciles', s2.total, before(sweptB, 2, 2));
  check('  with every part signed the same way', [s2.base < 0, s2.sweeps < 0, s2.quads < 0], [true, true, true]);

  // A sweep without a quad.
  const sweepOnly = { hasSweeps: true, hasQuads: false, sweepsTeam: 'A',
                      totalKPValue: 16, sweepsBonus: 16, quadsBonus: 0, grandTotal: 32, netA: 16 };
  const s3 = Game.kpTeamSplit(sweepOnly, 2, 2);
  check('no quad, no quad line', s3.quads, 0);
  check('  and it reconciles', s3.total, before(sweepOnly, 2, 2));

  // The ordinary round, which is most of them: KPs traded, nobody swept.
  const plain = { hasSweeps: false, hasQuads: false, sweepsTeam: null,
                  totalKPValue: 16, sweepsBonus: 0, quadsBonus: 0, grandTotal: 16, netA: 4 };
  const s4 = Game.kpTeamSplit(plain, 2, 2);
  check('an ordinary round is one line', [s4.sweeps, s4.quads], [0, 0]);
  check('  showing the NET of the holes, not the gross pot', s4.base, 8);
  check('  and reconciles', s4.total, before(plain, 2, 2));

  // Uneven teams — 2 v 3 — where the multiplier is the side being paid.
  const uneven = { ...swept };
  const s5 = Game.kpTeamSplit(uneven, 2, 3);
  check('uneven teams reconcile too', s5.total, before(uneven, 2, 3));

  // Nothing at all.
  const none = { hasSweeps: false, hasQuads: false, netA: 0, totalKPValue: 0, grandTotal: 0 };
  check('no KP money is four zeros', Object.values(Game.kpTeamSplit(none, 2, 2)), [0, 0, 0, 0]);
  check('and a missing kp object does not throw', Game.kpTeamSplit(null, 2, 2).total, 0);
}

/**
 * The running cards (computeKPThroughHole) and sweeps.
 *
 * A sweep is winning EVERY par 3 of the round. The running cards filter the
 * par 3s to those already played, so at the turn a team that had won both
 * front-nine par 3s was being paid a sweep it had not earned yet. Replays
 * 2026-09-25, El Macero, junk $1 front / $2 back.
 */
console.log('\nrunning cards do not pay a sweep before the round is over\n');
{
  //                       h3 h7 h12 h16
  const G = {
    tyler: card([4, 3, 2, 5]),
    gary:  card([4, 5, 4, 3]),
    bunch: card([4, 5, 3, 4]),
    ken:   card([4, 5, 4, 3]),
    casey: card([5, 3, 3, 3]),
  };
  const kp925 = new Array(18).fill(null);
  kp925[2]  = { ranking: ['bunch'] };            // bogey -> carries
  kp925[6]  = { ranking: ['casey', 'tyler'] };
  kp925[11] = { ranking: ['tyler'] };
  kp925[15] = { ranking: ['gary'] };
  const mk = (a, b) => ({ ...mkGame(a, b, kp925, G), junkValue: { front: 1, back: 2 } });

  const g = mk(['tyler','gary'], ['bunch','ken']);
  const turn = Game.computeKPThroughHole(g, 8);
  check('at the turn: tyler/gary have won every par 3 so far, but no sweep', turn.hasSweeps, false);
  check('  so the card shows just the hole money', Game.kpTeamSplit(turn, 2, 2).total, 4);

  const full = Game.computeKPThroughHole(g, 17);
  check('through 18: now it is a sweep', [full.hasSweeps, full.sweepsTeam], [true, 'A']);
  check('  holes $6, sweep $6', [full.totalKPValue, full.sweepsBonus], [6, 6]);
  const fin = Game.computeKP(g);
  check('  and the running card agrees with final settlement',
    [full.hasSweeps, full.totalKPValue, full.sweepsBonus, full.grandTotal],
    [fin.hasSweeps, fin.totalKPValue, fin.sweepsBonus, fin.grandTotal]);

  const g2 = mk(['tyler','gary'], ['casey','bunch']);
  check('casey in the match takes hole 7 -> no sweep through 18', Game.computeKPThroughHole(g2, 17).hasSweeps, false);
}

console.log(fail ? `\n${fail} FAILURES` : '\nall checks passed');
process.exit(fail ? 1 : 0);
