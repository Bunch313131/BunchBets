import fs from 'node:fs';
const src = fs.readFileSync(process.argv[2], 'utf8');

// Pull the REAL functions out of index.html and run them against a stub Game
// whose holeDiff just reads a supplied array. This tests the shipped code, not
// a copy of it.
function extract(name, startPat) {
  const i = src.indexOf(startPat);
  if (i < 0) throw new Error('not found: ' + name);
  let depth = 0, j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') { depth--; if (depth === 0) return src.slice(i, k + 1); }
  }
}
const live = extract('buildSegment', '  buildSegment(g, start, end, stake, autoPress) {');
const thru = extract('buildSegmentThroughHole', '  buildSegmentThroughHole(g, start, end, stake, autoPress, maxHole) {');

const Game = eval(`({ holeDiff(g, h) { return g.__diffs[h]; }, ${live}, ${thru} })`);

// The reference implementation the fuzz suite validated.
function pressNew(diffs, start, end, stake) {
  const lines = [{ start, end, stake, pressesTriggered: 0 }];
  for (let h = start; h <= end; h++) {
    if (h >= end) break;
    const line = lines[lines.length - 1];
    if (line.start > h || line.pressesTriggered) continue;
    let cum = 0;
    for (let i = line.start; i <= h; i++) if (diffs[i] != null) cum += diffs[i];
    if (Math.abs(cum) >= 2) {
      const next = h + 1;
      if (!lines.some((l) => l.start === next)) {
        lines.push({ start: next, end, stake, pressedBy: cum < 0 ? 'A' : 'B', pressesTriggered: 0 });
      }
      line.pressesTriggered = 1;
    }
  }
  return lines.map((l) => l.start);
}

let seed = 7;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const mk = (holes) => {
  const d = new Array(18).fill(null);
  for (let i = 0; i < holes; i++) {
    if (rnd() < 0.05) continue;
    const r = rnd();
    d[i] = r < 0.15 ? 2 : r < 0.45 ? 1 : r < 0.6 ? 0 : r < 0.85 ? -1 : -2;
  }
  return d;
};

let bad = 0, badThru = 0, n = 0;
for (let i = 0; i < 20000; i++) {
  const diffs = mk(18);
  const g = { __diffs: diffs, teamA: ['a1', 'a2'], teamB: ['b1', 'b2'] };
  n++;
  const got = Game.buildSegment(g, 0, 8, 5, true).lines.map((l) => l.start);
  const want = pressNew(diffs, 0, 8, 5);
  if (JSON.stringify(got) !== JSON.stringify(want)) bad++;

  // through-hole must agree with the live version when the round is complete
  const gotT = Game.buildSegmentThroughHole(g, 0, 8, 5, true, 17).lines.map((l) => l.start);
  if (JSON.stringify(gotT) !== JSON.stringify(want)) badThru++;
}
console.log(`shipped buildSegment matches the fuzz-validated rule : ${n - bad}/${n}`);
console.log(`buildSegmentThroughHole agrees with buildSegment     : ${n - badThru}/${n}`);
