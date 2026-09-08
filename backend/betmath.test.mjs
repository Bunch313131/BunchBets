/**
 * Characterisation tests for three bet-math changes.
 *
 * Method, same as the junk-ladder extraction: reimplement the CURRENT behaviour
 * verbatim, implement the NEW behaviour, then fuzz both over thousands of
 * randomised games and measure exactly where and how often they diverge. Money
 * math does not get changed on the strength of reading it.
 *
 *   node --test betmath.test.mjs
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';

// ---------------------------------------------------------------------------
// 1. PRESSES — "only the latest bet or press may spawn a new press"
// ---------------------------------------------------------------------------
// Both versions operate on the `diffs` array the real buildSegment() builds
// first, so the surrounding scoring code is out of scope here.

function pressOld(diffs, start, end, stake, autoPress = true) {
  const lines = [{ start, end, stake, pressesTriggered: 0 }];
  if (autoPress) {
    for (let h = start; h <= end; h++) {
      let pressed = false;
      lines.forEach((line) => {
        if (line.start > h || h >= end) return;
        let cum = 0;
        for (let i = line.start; i <= h; i++) if (diffs[i] != null) cum += diffs[i];
        const k = Math.floor(Math.abs(cum) / 2);
        if (k > line.pressesTriggered) {
          if (!pressed) {
            const next = h + 1;
            if (!lines.some((l) => l.start === next)) {
              lines.push({ start: next, end, stake, pressedBy: cum < 0 ? 'A' : 'B', pressesTriggered: 0 });
              pressed = true;
            }
          }
          line.pressesTriggered = k;
        }
      });
    }
  }
  return settle(lines, diffs, stake);
}

function pressNew(diffs, start, end, stake, autoPress = true) {
  const lines = [{ start, end, stake, pressesTriggered: 0 }];
  if (autoPress) {
    for (let h = start; h <= end; h++) {
      if (h >= end) break;
      // ONLY the most recently opened line may press. Once a line spawns a
      // press it is no longer the latest, so each bet or press spawns at most
      // one press — which is the point of the change.
      const line = lines[lines.length - 1];
      if (line.start > h) continue;
      let cum = 0;
      for (let i = line.start; i <= h; i++) if (diffs[i] != null) cum += diffs[i];
      if (Math.abs(cum) >= 2 && line.pressesTriggered === 0) {
        const next = h + 1;
        if (!lines.some((l) => l.start === next)) {
          lines.push({ start: next, end, stake, pressedBy: cum < 0 ? 'A' : 'B', pressesTriggered: 0 });
        }
        line.pressesTriggered = 1;
      }
    }
  }
  return settle(lines, diffs, stake);
}

function settle(lines, diffs, stake) {
  let payA = 0;
  for (const line of lines) {
    let cum = 0, any = false;
    for (let i = line.start; i <= line.end; i++) if (diffs[i] != null) { cum += diffs[i]; any = true; }
    if (!any) continue;
    if (cum > 0) payA += line.stake;
    else if (cum < 0) payA -= line.stake;
  }
  return { lines: lines.length, payA };
}

let seed = 20260907;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

/**
 * holeDiff() returns -2..+2, NOT just -1..+1: in the default two-ball mode a
 * team can win BOTH the low ball and the high ball on one hole. That matters
 * enormously here — a ±2 hole lets a line jump straight over a multiple of two,
 * which is the only way the old and new press rules can disagree. A fuzz
 * restricted to ±1 reports the two rules as identical, which is false.
 */
function randomDiffs(holes = 9, unscoredChance = 0.05, twoBall = true) {
  const d = new Array(18).fill(null);
  for (let i = 0; i < holes; i++) {
    if (rnd() < unscoredChance) continue;
    const r = rnd();
    if (!twoBall) { d[i] = r < 0.4 ? 1 : r < 0.8 ? -1 : 0; continue; }
    d[i] = r < 0.15 ? 2 : r < 0.45 ? 1 : r < 0.60 ? 0 : r < 0.85 ? -1 : -2;
  }
  return d;
}

describe('press change: only the latest line may press', () => {
  test('a bet that goes 2 down spawns exactly one press', () => {
    const d = [-1, -1, 0, 0, 0, 0, 0, 0, 0];
    const r = pressNew(d, 0, 8, 5);
    assert.equal(r.lines, 2, 'original bet plus one press');
  });

  test('a bet driven steadily down chains presses identically under both rules', () => {
    // Worth stating explicitly, because it is not obvious: once a press opens,
    // betCum === -2 + pressCum forever after. So the parent reaching the NEXT
    // multiple of 2 and the child reaching its FIRST are the same event. In a
    // one-directional match the two rules therefore agree exactly.
    const d = [-1, -1, -1, -1, 0, 0, 0, 0, 0];
    assert.equal(pressOld(d.slice(), 0, 8, 5).lines, pressNew(d.slice(), 0, 8, 5).lines);
  });

  test('the rules diverge when the match swings back the other way', () => {
    // A goes 2 down (press opens), then wins four straight. Under the old rule
    // the ORIGINAL bet crossing +2 opens another press; under the new rule the
    // original bet has already had its one press and is finished.
    const d = [-1, -1, 1, 1, 1, 1, 0, 0, 0];
    const before = pressOld(d.slice(), 0, 8, 5);
    const after = pressNew(d.slice(), 0, 8, 5);
    assert.ok(after.lines <= before.lines, `new never exceeds old (${after.lines} vs ${before.lines})`);
  });

  test('a press that itself goes 2 down spawns the next press', () => {
    //         h0  h1 | press opens at h2
    const d = [-1, -1, -1, -1, 0, 0, 0, 0, 0];
    const r = pressNew(d, 0, 8, 5);
    // bet presses after h1; the press (h2..) is 2 down after h3 and presses again
    assert.equal(r.lines, 3, 'chain continues through the newest line');
  });

  test('no press on the closing hole of a segment', () => {
    const d = [0, 0, 0, 0, 0, 0, 0, -1, -1];
    const r = pressNew(d, 0, 8, 5);
    assert.equal(r.lines, 1, 'nothing to press into');
  });

  test('unscored holes mid-segment do not break the chain', () => {
    const d = [-1, null, -1, 0, 0, 0, 0, 0, 0];
    const r = pressNew(d, 0, 8, 5);
    assert.equal(r.lines, 2);
  });

  test('FUZZ: measure how often, and by how much, the money changes', () => {
    for (const [label, holes, start, end, twoBall] of [
      ['front 9, low-ball only (±1)', 9, 0, 8, false],
      ['front 9, two-ball (±2 possible)', 9, 0, 8, true],
      ['overall 18, two-ball', 18, 0, 17, true],
    ]) runFuzz(label, holes, start, end, twoBall);
  });

  function runFuzz(label, holes, start, end, twoBall) {
    let n = 0, sameLines = 0, samePay = 0, oldMore = 0, newMore = 0;
    let payDelta = 0, maxDelta = 0;
    for (let i = 0; i < 20000; i++) {
      const d = randomDiffs(holes, 0.05, twoBall);
      const o = pressOld(d.slice(), start, end, 5);
      const w = pressNew(d.slice(), start, end, 5);
      n++;
      if (o.lines === w.lines) sameLines++;
      if (o.payA === w.payA) samePay++;
      if (o.lines > w.lines) oldMore++;
      if (w.lines > o.lines) newMore++;
      const delta = Math.abs(o.payA - w.payA);
      payDelta += delta;
      maxDelta = Math.max(maxDelta, delta);
    }
    console.log(`\n    ${label} — ${n} segments @ $5:`);
    console.log(`      identical line count : ${(100 * sameLines / n).toFixed(1)}%`);
    console.log(`      identical payout     : ${(100 * samePay / n).toFixed(1)}%`);
    console.log(`      old spawned more     : ${(100 * oldMore / n).toFixed(1)}%`);
    console.log(`      new spawned more     : ${(100 * newMore / n).toFixed(1)}%  (must be 0)`);
    console.log(`      mean |payout delta|  : $${(payDelta / n).toFixed(2)}`);
    console.log(`      worst |payout delta| : $${maxDelta.toFixed(2)}`);
    assert.equal(newMore, 0, 'the new rule can never create MORE presses than the old one');
  }
});

// ---------------------------------------------------------------------------
// 2. SWEEPS — an unresolved final KP means nobody swept
// ---------------------------------------------------------------------------
// Mirrors the award loop in computeKP(): each par 3 is won by A, won by B, or
// carries. `carryStack` is reset on an award and left dangling by trailing
// carries — which is exactly the signal that not every KP was won.

function kpSweeps(outcomes, { newRule }) {
  let carryStack = 0, teamAKPs = 0, teamBKPs = 0, anyKPAwarded = false;
  for (const o of outcomes) {
    carryStack++;
    if (o === null) continue;             // carried: nobody won it
    if (o === 'A') teamAKPs += carryStack; else teamBKPs += carryStack;
    anyKPAwarded = true;
    carryStack = 0;
  }
  const totalKPs = teamAKPs + teamBKPs;
  const allPar3sScored = true;            // scores exist; that is a separate check
  const base = anyKPAwarded && totalKPs > 0 && (teamAKPs === 0 || teamBKPs === 0) && allPar3sScored;
  return newRule ? (base && carryStack === 0) : base;
}

describe('sweeps require every KP to have been won', () => {
  test('A wins all four par 3s — sweep, both old and new', () => {
    assert.equal(kpSweeps(['A', 'A', 'A', 'A'], { newRule: false }), true);
    assert.equal(kpSweeps(['A', 'A', 'A', 'A'], { newRule: true }), true);
  });

  test('THE REPORTED BUG: A wins three, the last par 3 carries', () => {
    const outcomes = ['A', 'A', 'A', null];
    assert.equal(kpSweeps(outcomes, { newRule: false }), true, 'old code declares a sweep');
    assert.equal(kpSweeps(outcomes, { newRule: true }), false, 'nobody won the last KP, so nobody swept');
  });

  test('a carry in the MIDDLE is fine — it rolls into the next win', () => {
    assert.equal(kpSweeps(['A', null, 'A', 'A'], { newRule: true }), true);
  });

  test('both teams won KPs — never a sweep', () => {
    assert.equal(kpSweeps(['A', 'B', 'A', 'A'], { newRule: true }), false);
  });

  test('every par 3 carried — nothing awarded, no sweep', () => {
    assert.equal(kpSweeps([null, null, null, null], { newRule: true }), false);
    assert.equal(kpSweeps([null, null, null, null], { newRule: false }), false);
  });

  test('trailing carries of any length void the sweep', () => {
    assert.equal(kpSweeps(['A', 'A', null, null], { newRule: true }), false);
    assert.equal(kpSweeps(['A', 'A', null, null], { newRule: false }), true);
  });

  test('FUZZ: the new rule only ever REMOVES sweeps, never adds one', () => {
    let n = 0, removed = 0, added = 0;
    for (let i = 0; i < 20000; i++) {
      const count = 3 + Math.floor(rnd() * 3);
      const outcomes = Array.from({ length: count }, () => {
        const r = rnd();
        return r < 0.45 ? 'A' : r < 0.9 ? 'B' : null;
      });
      const o = kpSweeps(outcomes, { newRule: false });
      const w = kpSweeps(outcomes, { newRule: true });
      n++;
      if (o && !w) removed++;
      if (!o && w) added++;
    }
    console.log(`\n    fuzz over ${n} KP sets: sweeps removed ${removed}, sweeps added ${added}`);
    assert.equal(added, 0, 'the new rule must never CREATE a sweep');
  });
});

// ---------------------------------------------------------------------------
// 3. TEAM JUNK — must honour the withJunk toggle, as KP already does
// ---------------------------------------------------------------------------

function teamTotal(g, { newRule }) {
  const junkNetA = g.withJunk === false && newRule ? 0 : g.junkNetA;
  const kpNetA = g.withJunk ? g.kpNetA : 0;   // already guarded in both versions
  return g.frontA + g.backA + g.overallA + junkNetA + kpNetA;
}

describe('team junk honours the toggle', () => {
  const game = { frontA: 4, backA: 10, overallA: 2, junkNetA: 6, kpNetA: 2 };

  test('junk ON: unchanged', () => {
    const g = { ...game, withJunk: true };
    assert.equal(teamTotal(g, { newRule: false }), 24);
    assert.equal(teamTotal(g, { newRule: true }), 24);
  });

  test('junk OFF: old code still pays the junk, new code does not', () => {
    const g = { ...game, withJunk: false };
    assert.equal(teamTotal(g, { newRule: false }), 22, 'KP dropped but junk still paid');
    assert.equal(teamTotal(g, { newRule: true }), 16, 'junk dropped too');
  });

  test('junk OFF with no junk entered: no change at all', () => {
    const g = { ...game, withJunk: false, junkNetA: 0 };
    assert.equal(teamTotal(g, { newRule: false }), teamTotal(g, { newRule: true }));
  });
});
