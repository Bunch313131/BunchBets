/**
 * Every `Obj.method(...)` in the app must name a method that object actually
 * has.
 *
 * Written after `UI.kpParts` shipped in 7.11 and threw for four releases. The
 * helper was defined on `History` — one object earlier in the same file — while
 * all six callers were in `UI`. There is no build step and no module system, so
 * nothing anywhere said a word: the file parses, `node --check` passes, and the
 * call only fails the moment a human reaches a screen that needs it. The first
 * one to reach it was Brian, sharing a finished round from the course.
 *
 * That is the shape of the bug this guards:
 *
 *   - a method attached to the wrong object literal
 *   - a method renamed at its definition and not at a caller
 *   - a caller left behind when a method is deleted
 *
 * Each is invisible until the exact screen runs, and some of those screens only
 * appear when the round has a particular kind of money in it — which is why
 * four releases went by.
 *
 * Reading the file rather than running the app, deliberately: running it can
 * only reach the paths a test thinks to visit, and the whole problem is that
 * nobody thought to visit this one.
 *
 * It leans on the file's layout convention — top-level objects open with
 * `const X = {` in column zero and close with `};` in column zero, members are
 * declared at exactly two spaces. That is a real constraint on this file, and a
 * cheap one to keep. The first version of this counted braces through the whole
 * file instead, and a quote inside a regex literal was enough to lose the
 * count: UI came back with 29 of its members and the checker reported two dozen
 * perfectly good calls as broken. A check that cries wolf gets ignored, and
 * then it is worse than not having one, so this one asserts its own reading of
 * the file before it reports anything.
 *
 *   node backend/verify-refs.mjs index.html
 */
import fs from 'node:fs';

const FILE = process.argv[2] || 'index.html';
const lines = fs.readFileSync(FILE, 'utf8').split('\n');

let fail = 0;
const check = (label, ok, detail) => {
  if (!ok) fail++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${ok || !detail ? '' : '\n          ' + detail}`);
};

// ---------------------------------------------------------------- the objects
const objects = {};
lines.forEach((l, i) => {
  const m = l.match(/^(?:const|window\.)\s*([A-Z][A-Za-z_]*)\s*=\s*\{\s*$/)
         || l.match(/^window\.([A-Z][A-Za-z_]*)\s*=\s*\{\s*$/);
  if (!m) return;
  let end = -1;
  for (let j = i + 1; j < lines.length; j++) {
    if (/^\};?\s*$/.test(lines[j])) { end = j; break; }
  }
  if (end < 0) return;
  const members = new Set();
  for (let j = i + 1; j < end; j++) {
    const mm = lines[j].match(/^ {2}(?:async\s+)?([A-Za-z_]\w*)\s*(?:\(|:)/);
    if (mm) members.add(mm[1]);
  }
  objects[m[1]] = { start: i + 1, end: end + 1, members };
});

const MODULES = ['Cloud', 'Utils', 'State', 'History', 'Game', 'Wizard', 'UI', 'LiveSync', 'Err'];
const present = MODULES.filter((n) => objects[n]);

console.log(`${FILE}\n`);
present.forEach((n) => console.log(
  `  ${n.padEnd(9)} lines ${String(objects[n].start).padStart(6)}-${String(objects[n].end).padEnd(6)} ${String(objects[n].members.size).padStart(3)} members`));
console.log('');

// ------------------------------------------------- does the reading hold up?
// Before trusting a word of the report below, prove the parse found the modules
// and a sample of members it must not be able to miss. Without this the failure
// mode is silent and inverted: a parse that finds nothing reports nothing wrong.
check('the modules were all found', present.length >= 7, 'found: ' + present.join(', '));
check('  and each has a plausible number of members',
  present.every((n) => objects[n].members.size >= 3),
  present.map((n) => `${n}:${objects[n].members.size}`).join(' '));
// Real members, checked against the file — a sentinel that names something
// which does not exist makes the guard fail on a good parse, which is the same
// crying-wolf failure it exists to prevent.
const SENTINELS = [['UI', 'render'], ['UI', 'playerName'], ['UI', 'shareImage'],
                   ['Game', 'computeResult'], ['State', 'scheduleSave'],
                   ['History', 'archiveCurrent'], ['Wizard', 'render']];
const missed = SENTINELS.filter(([o, m]) => !(objects[o] && objects[o].members.has(m)));
check('  and members it cannot possibly be missing are there', missed.length === 0,
  missed.map((x) => x.join('.')).join(', '));
if (fail) { console.log('\nthe parse is wrong — not reporting references off a bad reading'); process.exit(1); }

// ------------------------------------------------------------ the references
// Comment lines are skipped: this file's own header names UI.kpParts.
const isComment = (l) => /^\s*(\/\/|\*|\/\*)/.test(l);
const bad = [];
const re = /\b([A-Z][A-Za-z_]*)\.([A-Za-z_]\w*)\s*\(/g;
const whole = lines.join('\n');
lines.forEach((l, i) => {
  if (isComment(l)) return;
  let m;
  while ((m = re.exec(l))) {
    const [, obj, member] = m;
    const o = objects[obj];
    if (!o || !MODULES.includes(obj)) continue;
    if (o.members.has(member)) continue;
    // Assigned at runtime rather than declared in the literal.
    if (new RegExp(`\\b${obj}\\.${member}\\s*=[^=]`).test(whole)) continue;
    bad.push(`${obj}.${member}()  line ${i + 1}\n            ${l.trim().slice(0, 78)}`);
  }
});

check('every Obj.method() call names a method that object has', bad.length === 0,
  bad.join('\n          '));

// The one this was written for, named so the regression is legible in the
// output rather than only in a count.
check('kpParts is on UI, where its callers are',
  !!(objects.UI && objects.UI.members.has('kpParts')),
  'it sat on History for four releases while every caller said UI.kpParts');
const callers = [];
lines.forEach((l, i) => { if (/\bkpParts\(/.test(l) && !/^ {2}kpParts\(/.test(l) && !isComment(l)) callers.push(i + 1); });
check(`  and all ${callers.length} of its callers are inside UI`,
  callers.length >= 6 && callers.every((n) => n > objects.UI.start && n < objects.UI.end),
  'lines: ' + callers.join(', '));

console.log(fail ? `\n${fail} FAILURES` : '\nall checks passed');
process.exit(fail ? 1 : 0);
