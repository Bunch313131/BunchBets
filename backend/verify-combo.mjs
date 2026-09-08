// Extracts the SHIPPED comboStrokes/computeCombo out of index.html and runs them
// against Aug 27 2026 at El Macero. Expected: 207 for 1 gross + 2 net.
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

const body = [grab('comboStrokes'), grab('computeCombo')].join(',\n');
const Game = eval('({' + body + '})');

const gross = {
  BRIDGES: [4,7,3,4,6,6,3,5,4, 4,4,4,4,4,5,3,4,5],
  CASEY:   [4,5,4,4,6,4,3,5,5, 4,5,3,4,4,5,3,4,6],
  BUNCH:   [4,4,4,6,6,5,5,5,4, 3,5,3,4,6,7,3,6,5],
  KEN:     [5,6,4,5,6,4,3,4,6, 5,6,3,4,4,6,3,5,5],
  TIM:     [4,8,4,6,8,6,5,6,5, 5,6,4,4,5,6,4,8,6],
};
const handicap = { BRIDGES:3, CASEY:7, BUNCH:8, KEN:13, TIM:21 };
const hcpArr = [15,13,9,1,7,3,17,11,5, 8,2,16,6,10,12,18,4,14];

const s = {
  players: Object.keys(gross).map(id => ({ id, name: id })),
  gross, handicap, hcpArr,
  parArr: [4,5,4,4,5,4,3,4,4, 4,5,3,4,4,5,3,4,4],
  startingHole: 0, courseName: 'El Macero CC',
};

let fail = 0;
for (const [ng, nn, expect] of [[1,2,207],[1,1,null],[2,1,null],[2,2,null],[1,3,null]]) {
  const r = Game.computeCombo(s, ng, nn);
  const tag = expect == null ? '' : (r.total === expect ? '  OK' : '  FAIL expected ' + expect);
  if (expect != null && r.total !== expect) fail++;
  console.log(`${ng} gross + ${nn} net: ${r.total}  (${r.holesScored} holes)${tag}`);
}

// A player must never supply both a gross and a net on the same hole.
const r = Game.computeCombo(s, 1, 2);
for (const h of r.holes) {
  if (h.sum == null) continue;
  for (const p of h.gross) if (h.net.indexOf(p) >= 0) { console.log('FAIL: ' + p + ' double-counted on hole ' + (h.pos+1)); fail++; }
  if (h.gross.length !== 1 || h.net.length !== 2) { console.log('FAIL: wrong shape on hole ' + (h.pos+1)); fail++; }
}

// Partial round: only 9 holes entered.
const half = JSON.parse(JSON.stringify(s));
Object.keys(half.gross).forEach(p => { for (let i=9;i<18;i++) half.gross[p][i] = null; });
const hr = Game.computeCombo(half, 1, 2);
console.log(`front nine only: ${hr.total} (${hr.holesScored} holes)` + (hr.holesScored === 9 ? '  OK' : '  FAIL'));
if (hr.holesScored !== 9) fail++;

// Too few players for the combination.
const thin = { ...s, players: s.players.slice(0,2) };
const tr = Game.computeCombo(thin, 1, 2);
console.log(`2 players @ 1+2: total ${tr.total}, holes ${tr.holesScored}` + (tr.holesScored === 0 ? '  OK' : '  FAIL'));
if (tr.holesScored !== 0) fail++;

console.log(fail ? '\n' + fail + ' FAILURES' : '\nall checks passed');
process.exit(fail ? 1 : 0);
