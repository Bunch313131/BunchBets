/**
 * Extracts the SHIPPED golferIdFor/buildRound out of index.html and checks the
 * local-round -> cloud-round mapping.
 *
 * The risk this guards is quiet and slow-acting: a round filed under the wrong
 * golfer id does not fail, it just shows up months later as someone's season
 * total being wrong. So the matching rule is deliberately strict — exact on a
 * normalised name, ambiguity counts as no match — and these cases pin that down.
 *
 * Usage: node backend/verify-round-map.mjs index.html
 */
import fs from 'node:fs';
const src = fs.readFileSync(process.argv[2] || 'index.html', 'utf8');

function grab(name) {
  let i = src.indexOf('\n  ' + name + '(');
  if (i < 0) i = src.indexOf('\n  async ' + name + '(');
  if (i < 0) throw new Error('not found: ' + name);
  let d = 0, started = false, j = i;
  for (; j < src.length; j++) {
    const c = src[j];
    if (c === '{') { d++; started = true; }
    else if (c === '}') { d--; if (started && d === 0) { j++; break; } }
  }
  return src.slice(i, j);
}

globalThis.APP_VERSION = '0.0-test';
// The shipped methods call Cloud.norm() by name, so the object under test has
// to BE the global Cloud. History is stubbed per-test for unlinkedNames().
const make = (pool, groups, history) => {
  const o = eval('({' + ['golferIdFor', 'norm', 'unlinkedNames', 'suggestFor', 'buildRound', 'linkNames']
    .map(grab).join(',\n') + '})');
  o.pool = pool; o.groups = groups;
  globalThis.Cloud = o;
  globalThis.History = { load: () => history || [] };
  return o;
};

const POOL = [
  { id: 'ghin:1506580', name: 'Brian Bunch' },
  { id: 'ghin:1236530', name: 'Brian Casey' },
  { id: 'ghin:1586673', name: 'Gary Nunes' },
  { id: 'ghin:8311822', name: 'Kenneth Bernard' },
  { id: 'ghin:1013155', name: 'Brandon Bridges' },
];
const GROUPS = [{ id: 'nunes', name: 'Nunes' }];

let fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}` + (ok ? '' : `\n          got  ${JSON.stringify(got)}\n          want ${JSON.stringify(want)}`));
};

console.log('name matching — exact only, and ambiguity is not a match\n');
{
  const C = make(POOL, GROUPS);
  check('exact', C.golferIdFor('Brian Bunch'), 'ghin:1506580');
  check('case and spacing are noise', C.golferIdFor('  brian   BUNCH '), 'ghin:1506580');
  check('punctuation is noise', C.golferIdFor('Brian Bunch.'), 'ghin:1506580');
  check('a first name alone is NOT a match', C.golferIdFor('Brian'), null);
  check('a nickname is NOT a match', C.golferIdFor('Ken Bernard'), null);
  check('someone not in the pool', C.golferIdFor('Sandy Lyle'), null);
  check('empty', C.golferIdFor(''), null);

  const dupes = make(POOL.concat([{ id: 'ghin:999', name: 'Brian Bunch' }]), GROUPS);
  check('two golfers with one name -> no match, never a guess', dupes.golferIdFor('Brian Bunch'), null);
}

console.log('\nsuggestions — ranked, never applied without a tap\n');
{
  const C = make(POOL, GROUPS);
  const names = (n) => C.suggestFor(n).map((g) => g.name);
  check('surname is the strongest signal', names('Bunch')[0], 'Brian Bunch');
  check('  because it is what the card says', names('Casey')[0], 'Brian Casey');
  check('first name next', names('Gary')[0], 'Gary Nunes');
  check('prefix last — Ken/Kenneth', names('Ken')[0], 'Kenneth Bernard');
  check('a name with no pool entry suggests nothing', names('Tyler'), []);
  check('an ambiguous first name still offers both, ranked', names('Brian').length, 2);

  const withAlias = make(POOL.map((g) =>
    g.id === 'ghin:8311822' ? { ...g, aliases: ['Ken'] } : g), GROUPS);
  check('a confirmed alias resolves outright', withAlias.golferIdFor('Ken'), 'ghin:8311822');
  check('  and outranks everything as a suggestion', withAlias.suggestFor('Ken')[0].name, 'Kenneth Bernard');
}

console.log('\nunlinked names, scanned out of local history\n');
{
  const hist = [
    { players: [{ id: 'p1', name: 'Bunch' }, { id: 'p2', name: 'Brian Casey' }] },
    { players: [{ id: 'p1', name: 'bunch' }, { id: 'p3', name: 'Tyler' }] },
    { players: [{ id: 'p4', name: '  ' }] },
  ];
  const C = make(POOL, GROUPS, hist);
  check('only the ones that resolve to nobody', C.unlinkedNames(), ['Bunch', 'Tyler']);
  check('  deduped case-insensitively, first spelling kept', C.unlinkedNames().indexOf('bunch'), -1);
}

console.log('\nbuilding the round\n');
const card = (v) => { const a = new Array(18).fill(null); v.forEach((x, i) => a[i] = x); return a; };
const full = card(Array(18).fill(4));                       // 72
const partial = card(Array(9).fill(4));                     // 9 holes only

const snapshot = {
  id: 'local-abc',
  date: '2026-09-13T15:00:00.000Z',
  course: { name: 'El Macero', par: Array(18).fill(4), hcp: Array(18).fill(1) },
  players: [
    { id: 'p1', name: 'Brian Bunch', handicap: 7 },
    { id: 'p2', name: 'Brian Casey', handicap: 5 },
    { id: 'p3', name: 'Ken Bernard', handicap: 11 },   // pool has "Kenneth" — guest
    { id: 'p4', name: 'Visiting Steve', handicap: 20 },
    { id: 'p5', name: '   ', handicap: 0 },            // empty slot, must be dropped
  ],
  games: [{ id: 'g1', gameType: 'nassau',
            gross: { p1: full, p2: full, p3: partial, p4: full } }],
  playerNet: { p1: 12, p2: -12, p3: 4, p4: -4 },
  startingHole: 0,
};

{
  const C = make(POOL, GROUPS);
  const r = C.buildRound(snapshot);

  check('keeps the local id so the doc is stable', r.id, 'local-abc');
  check('attributed to the group', r.groupId, 'nunes');
  check('course name carried', r.courseName, 'El Macero');
  check('empty player slot dropped', r.golferIds.length, 4);
  check('matched players get their ghin id', r.golferIds.slice(0, 2), ['ghin:1506580', 'ghin:1236530']);
  check('unmatched become guests, not wrong people', r.golferIds.slice(2), ['guest:ken-bernard', 'guest:visiting-steve']);
  check('and they are named explicitly', r.unmatchedNames, ['Ken Bernard', 'Visiting Steve']);

  check('money carried per golfer', r.results['ghin:1506580'].money, 12);
  check('gross totalled for a complete round', r.results['ghin:1506580'].gross, 72);
  check('name kept so the round reads without the pool', r.results['ghin:1236530'].name, 'Brian Casey');
  check('handicap kept', r.results['ghin:1236530'].handicap, 5);

  // The one that protects a scoring average.
  check('a 9-hole card has NO gross total', r.results['guest:ken-bernard'].gross, null);
  check('but records how many holes it was', r.results['guest:ken-bernard'].holes, 9);

  check('games carried through', r.games.length, 1);
  check('version stamped', r.appVersion, '0.0-test');
}

console.log('\nno group yet — a personal round\n');
{
  const C = make([], []);
  const r = C.buildRound(snapshot);
  check('groupId is null, which the rules allow', r.groupId, null);
  check('everyone is a guest without a pool', r.golferIds,
    ['guest:brian-bunch', 'guest:brian-casey', 'guest:ken-bernard', 'guest:visiting-steve']);
  check('and the round is still complete', Object.keys(r.results).length, 4);
}

console.log('\nedges\n');
{
  const C = make(POOL, GROUPS);
  const empty = C.buildRound({ id: 'x', date: 'd', players: [], games: [], playerNet: {} });
  check('a round with no players does not throw', empty.golferIds, []);
  const noGames = C.buildRound({ id: 'y', date: 'd', players: [{ id: 'p1', name: 'Brian Bunch' }], playerNet: {} });
  check('no games -> no gross, no crash', noGames.results['ghin:1506580'].gross, null);
  check('and money defaults to zero', noGames.results['ghin:1506580'].money, 0);
}

/**
 * The rule under test: linking a name must re-send the rounds that name appears
 * in. The first version of this decided what to re-send by rebuilding each round
 * and skipping any with no "guest:" left — which, because the aliases are already
 * applied by then, skipped every round it existed to fix. Silent: it reported
 * "5 names linked" and changed nothing in the cloud.
 */
console.log('\nrelinking — the rounds that just became linkable are the ones that must be re-sent\n');
{
  const hist = [
    { id: 'r1', cloudId: 'r1', date: 'd', players: [{ id: 'p1', name: 'Bunch' }, { id: 'p2', name: 'Casey' }],
      games: [], playerNet: {} },
    { id: 'r2', cloudId: 'r2', date: 'd', players: [{ id: 'p1', name: 'Ian Bolnik' }],
      games: [], playerNet: {} },
    { id: 'r3', date: 'd', players: [{ id: 'p1', name: 'Bunch' }], games: [], playerNet: {} },  // never uploaded
  ];
  const C = make(POOL.map((g) => ({ ...g })), GROUPS, hist);

  const aliased = [], sent = [];
  C.api = { addAlias: async (gid, alias) => { aliased.push(gid + '=' + alias); } };
  C.user = { uid: 'u' };
  C.saveRound = async (r) => { sent.push(r.id); return true; };
  C.render = () => {};
  C.diag = () => {};
  C.refreshProfile = async () => {};

  await C.linkNames([
    { name: 'Bunch', golferId: 'ghin:1506580' },
    { name: 'Casey', golferId: 'ghin:1236530' },
    { name: 'Tyler', golferId: '' },            // "not in this group" — must be a no-op
  ]);

  check('aliases written for the confirmed pairs only',
    aliased, ['ghin:1506580=Bunch', 'ghin:1236530=Casey']);
  check('the round naming those men is re-sent', sent, ['r1']);
  check('  a round with nobody linked is left alone', sent.indexOf('r2'), -1);
  check('  and one never uploaded is not force-sent here', sent.indexOf('r3'), -1);
  check('the alias lands in the pool so matching works at once',
    C.golferIdFor('Bunch'), 'ghin:1506580');
  check('the status says what happened', /2 name\(s\) linked, 1 round\(s\) updated/.test(C.status), true);
}

console.log('\na failed alias write must not be reported as linked\n');
{
  const hist = [{ id: 'r1', cloudId: 'r1', date: 'd', players: [{ id: 'p1', name: 'Bunch' }], games: [], playerNet: {} }];
  const C = make(POOL.map((g) => ({ ...g })), GROUPS, hist);
  C.api = { addAlias: async () => { const e = new Error('nope'); e.code = 'permission-denied'; throw e; } };
  C.user = { uid: 'u' };
  const sent = [];
  C.saveRound = async (r) => { sent.push(r.id); return true; };
  C.render = () => {}; C.diag = () => {}; C.refreshProfile = async () => {};

  await C.linkNames([{ name: 'Bunch', golferId: 'ghin:1506580' }]);
  check('counted as failed, not linked', /0 name\(s\) linked/.test(C.status), true);
  check('  and said so', /1 failed/.test(C.status), true);
  check('the name still resolves to nobody', C.golferIdFor('Bunch'), null);
}

/**
 * js/cloud.js is the only shipped file the release ritual did not cover.
 *
 * index.html is fetched network-first, so a new build lands immediately. The
 * module is a same-origin asset served CACHE-FIRST and refreshed only in the
 * background, so a fix to it does nothing for a whole launch and says nothing
 * about it — which is how a corrected saveRound sat unused on a phone while the
 * old one went on writing the bug it had fixed.
 *
 * Static check on purpose: the invariant is in the source, and a runtime test
 * would need a service worker and two launches to observe it.
 */
console.log('\nthe cloud module is pinned to the release\n');
{
  const m = src.match(/import\('\.\/js\/cloud\.js([^']*)'\s*(\+\s*APP_VERSION)?\)/);
  check('index.html imports the module', !!m, true);
  check('  with a cache-busting query', !!(m && /\?v=$/.test(m[1])), true);
  check('  tied to APP_VERSION, not a literal', !!(m && m[2]), true);
}

console.log(fail ? `\n${fail} FAILURES` : '\nall checks passed');
process.exit(fail ? 1 : 0);
