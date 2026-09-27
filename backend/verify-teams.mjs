/**
 * Team suggestion: lowest handicap partners the highest.
 *
 * Extracts the SHIPPED Game.suggestTeams out of index.html and checks it
 * against the teams this group actually played, not against the rule as I
 * understood it. Brian, 2026-09-13: "if we play nassau, the default way teams
 * are chosen is low handicap and high handicap are partners... if there are 5,
 * the low/hi team can play up to three matches."
 *
 * The risk is the quiet kind again: a pairing that is merely plausible produces
 * a real settlement nobody questions on the first tee. So the fixtures are the
 * real handicaps off the real cards, and determinism is asserted explicitly —
 * a suggestion that reshuffles between renders is worse than none.
 *
 * Usage: node backend/verify-teams.mjs index.html
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

const Game = eval('({' + ['suggestTeams', 'applyHandicapMode', 'teamDeltaReceiver', 'fmtHcp'].map(grab).join(',') + '})');

let fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}` +
    (ok ? '' : `\n          got  ${JSON.stringify(got)}\n          want ${JSON.stringify(want)}`));
};

const P = (name, hcp) => ({ id: name.toLowerCase(), name, handicap: hcp });
const teams = (ms) => ms.map((m) => m.teamA.join('+') + ' v ' + m.teamB.join('+'));

// ---------------------------------------------------------------- four players
// The Sep 11 card: Tyler 0, Casey 6, Bunch 8, Ken 12, Gary 12 — take four.
console.log('four players — one match, and only one pairing balances\n');
{
  const r = Game.suggestTeams([P('Bunch', 8), P('Casey', 6), P('Ken', 12), P('Tyler', 0)]);
  check('one match', r.length, 1);
  check('lowest with highest', r[0].teamA, ['tyler', 'ken']);
  check('  and the middle two together', r[0].teamB, ['casey', 'bunch']);
  check('the delta is stated', r[0].deltaA, 12 - 14);

  // The alternatives, spelled out: any other split puts 0 and 6 on one side.
  check('it is NOT the two best together', r[0].teamA.includes('casey'), false);

  // Entry order must not matter.
  const shuffled = Game.suggestTeams([P('Ken', 12), P('Tyler', 0), P('Casey', 6), P('Bunch', 8)]);
  check('entry order changes nothing', teams(shuffled), teams(r));
}

console.log('\nfive players — the pair stays, three matches, everyone in two\n');
{
  const five = [P('Bunch', 8), P('Casey', 6), P('Gary', 12), P('Ken', 12), P('Tyler', 0)];
  const r = Game.suggestTeams(five);
  check('three matches', r.length, 3);
  check('the same pair every time', r.map((m) => m.teamA.join('+')),
    ['tyler+ken', 'tyler+ken', 'tyler+ken']);

  // Ken and Gary are both 12; the tie breaks on entry order, so Ken (entered
  // first) is the high man and Gary drops into the opposition.
  check('every pair of the other three, once each', r.map((m) => m.teamB.join('+')),
    ['casey+bunch', 'casey+gary', 'bunch+gary']);

  const appearances = {};
  r.forEach((m) => m.teamB.forEach((id) => { appearances[id] = (appearances[id] || 0) + 1; }));
  check('each of the three plays exactly twice', appearances, { casey: 2, bunch: 2, gary: 2 });
  check('nobody sits out', Object.keys(appearances).length, 3);

  check('each match carries its own delta', r.map((m) => m.deltaA), [12 - 14, 12 - 18, 12 - 20]);

  check('and it is the same list on a re-render', teams(Game.suggestTeams(five)), teams(r));

  // Ken and Gary are both 12, so which of them partners Tyler is a coin toss on
  // balance. It is settled by who was entered first, which means reversing the
  // card DOES change the answer — and that is the intended behaviour, not a
  // bug: order is the only signal available, it is the tee order they typed,
  // and the alternative is a suggestion that picks differently for no visible
  // reason. Either pairing is 12, and Change is one tap away.
  const reversed = Game.suggestTeams(five.slice().reverse());
  check('reversing the card hands the tie to the other 12',
    reversed.map((m) => m.teamA.join('+'))[0], 'tyler+gary');
  check('  and it is still three matches of the same shape', reversed.length, 3);
  check('  with the same total strokes in play',
    reversed.map((m) => m.deltaA).sort((a, b) => a - b), r.map((m) => m.deltaA).sort((a, b) => a - b));
}

console.log('\nplus handicaps — a plus man is the LOW man, not the high one\n');
{
  // Tyler is a +0.3 index; a plus course handicap is negative.
  const r = Game.suggestTeams([P('Tyler', -1), P('Bunch', 8), P('Ken', 12), P('Tim', 21)]);
  check('the plus is paired with the highest', r[0].teamA, ['tyler', 'tim']);
  check('  not treated as a 1', r[0].teamA.includes('bunch'), false);
  check('and the delta is signed correctly', r[0].deltaA, (-1 + 21) - (8 + 12));
}

console.log('\nties, which is most Saturdays\n');
{
  const all12 = Game.suggestTeams([P('A', 12), P('B', 12), P('C', 12), P('D', 12)]);
  check('four identical handicaps still produce a pairing', all12.length, 1);
  check('  taken in entry order', [all12[0].teamA, all12[0].teamB], [['a', 'd'], ['b', 'c']]);
  check('  with no strokes either way', all12[0].deltaA, 0);
}

console.log('\nwhen there is nothing to suggest\n');
{
  check('three players is not a two-man team game', Game.suggestTeams([P('A', 1), P('B', 2), P('C', 3)]), []);
  check('two players', Game.suggestTeams([P('A', 1), P('B', 2)]), []);
  check('none', Game.suggestTeams([]), []);
  check('undefined does not throw', Game.suggestTeams(undefined), []);
  check('six is past what the app plays', Game.suggestTeams([1,2,3,4,5,6].map((n) => P('P' + n, n))), []);
  check('a blank name slot is not a player',
    Game.suggestTeams([P('A', 1), P('B', 2), P('C', 3), { id: 'd', name: '  ', handicap: 9 }]), []);
}

/**
 * Who gets the strokes, as the teams screen SAYS it, against who gets them as
 * the engine ALLOCATES them. The screen said the wrong side "gives" strokes on
 * every match until 2026-09-27; the allocation was right all along, and the
 * two had drifted apart because nothing compared them. This does.
 *
 * The first case is the one Brian photographed: Ben Corfee is a plus 3.
 */
console.log('\nthe strokes caption names the man the engine gives them to\n');
{
  const allocate = (players, teamA, teamB) => {
    globalThis.State = { data: { players } };
    const g = { handicapMode: 'team_delta', teamA, teamB, strokesCount: {} };
    Game.applyHandicapMode(g);
    const got = Object.entries(g.strokesCount).filter(([, n]) => n > 0);
    return got.length ? { pid: got[0][0], strokes: got[0][1] } : null;
  };
  const said = (players, teamA, teamB) => {
    const h = {}; players.forEach((p) => { h[p.id] = p.handicap; });
    const r = Game.teamDeltaReceiver(teamA, teamB, (pid) => h[pid]);
    return r ? { pid: r.pid, strokes: r.strokes } : null;
  };

  const sat = [P('ben', -3), P('andy', 17), P('brandon', 3), P('aj', 8), P('bunch', 8)];
  check('Ben +3 & Andy 17 (14) v Brandon & A.J. (11): Andy gets 3',
    said(sat, ['ben', 'andy'], ['brandon', 'aj']), { pid: 'andy', strokes: 3 });
  check('  and that is who the engine gives them to',
    allocate(sat, ['ben', 'andy'], ['brandon', 'aj']), { pid: 'andy', strokes: 3 });
  check('14 v A.J. & Bunch (16): the OTHER side gets 2 — first of the tied 8s',
    said(sat, ['ben', 'andy'], ['aj', 'bunch']), { pid: 'aj', strokes: 2 });
  check('  engine agrees', allocate(sat, ['ben', 'andy'], ['aj', 'bunch']), { pid: 'aj', strokes: 2 });
  const lvl = sat.concat([P('six', 6)]);
  check('level sides (14 v 14): nobody', said(lvl, ['ben', 'andy'], ['six', 'aj']), null);
  check('  engine agrees', allocate(lvl, ['ben', 'andy'], ['six', 'aj']), null);

  // Every two-v-two split of a random five, with plus handicaps in the mix.
  let seed = 7, agree = 0, total = 0;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let t = 0; t < 400; t++) {
    const ps = ['a', 'b', 'c', 'd', 'e'].map((id) => P(id, Math.floor(rnd() * 30) - 5));
    const ids = ps.map((p) => p.id);
    for (let i = 0; i < 5; i++) for (let j = i + 1; j < 5; j++) {
      const A = [ids[i], ids[j]], rest = ids.filter((x) => !A.includes(x)), B = rest.slice(0, 2);
      total++;
      if (JSON.stringify(said(ps, A, B)) === JSON.stringify(allocate(ps, A, B))) agree++;
    }
  }
  check(`caption and engine agree on all ${total} random matches`, agree, total);

  check('a plus handicap reads +3', Game.fmtHcp(-3), '+3');
  check('scratch reads 0', Game.fmtHcp(0), '0');
  check('an ordinary one reads as itself', Game.fmtHcp(17), '17');
}

console.log(fail ? `\n${fail} FAILURES` : '\nall checks passed');
process.exit(fail ? 1 : 0);
