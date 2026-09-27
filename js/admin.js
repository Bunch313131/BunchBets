/**
 * Bunch Bets — admin operations.
 *
 * Used by admin.html only. Every function here runs as the site admin, whose
 * `admin` token claim makes firestore.rules' isAdmin() pass everything — so
 * nothing below is protected by the rules. It is protected by being careful:
 * each operation that touches more than one document says in full what it
 * rewrites, and does it in batches so a half-done merge is not left behind
 * for anything under 450 writes.
 *
 * The data model (see backend/README.md):
 *   groups/{id}    name, kind ('group' | absent = the directory), ownerUid,
 *                  memberUids, joinCode
 *   golfers/{id}   name, ghinNumber, currentIndex, aliases, poolGroupIds,
 *                  claimedByUid
 *   users/{uid}    displayName, email, groupIds, myGolferId
 *   rounds/{id}    groupId, date, courseName, golferIds, results{golferId:…},
 *                  createdByUid
 *   invites/{id}   groupId, email, golferId, invitedByUid, status
 */

let db = null;
let FV = null;

const BATCH_MAX = 450;

/** Collect writes, then commit in chunks under Firestore's 500-per-batch cap. */
function writer() {
  const ops = [];
  return {
    set: (ref, data, opts) => ops.push((b) => b.set(ref, data, opts || {})),
    update: (ref, data) => ops.push((b) => b.update(ref, data)),
    delete: (ref) => ops.push((b) => b.delete(ref)),
    get size() { return ops.length; },
    async commit() {
      for (let i = 0; i < ops.length; i += BATCH_MAX) {
        const b = db.batch();
        ops.slice(i, i + BATCH_MAX).forEach((op) => op(b));
        await b.commit();
      }
      return ops.length;
    },
  };
}

const all = async (name) => (await db.collection(name).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
const where = async (name, field, op, value) =>
  (await db.collection(name).where(field, op, value).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
const doc = (path) => db.doc(path);
const uniq = (arr) => [...new Set((arr || []).filter((x) => x != null && x !== ''))];

export const isDirectory = (g) => (g && g.kind) !== 'group';

export function init(firestore, fieldValue) {
  db = firestore;
  FV = fieldValue;
}

/** Everything, in one go. Fine at club scale; this is an admin screen, not the app. */
export async function loadAll() {
  const [groups, golfers, users, rounds, invites] = await Promise.all(
    ['groups', 'golfers', 'users', 'rounds', 'invites'].map(all));
  return { groups, golfers, users, rounds, invites };
}

// -------------------------------------------------------------------- groups

export async function renameGroup(groupId, name) {
  const nm = String(name || '').trim();
  if (!nm) throw new Error('a group needs a name');
  await doc(`groups/${groupId}`).update({ name: nm });
}

/** Hand the group to one of its members. */
export async function setOwner(groupId, uid) {
  const g = (await doc(`groups/${groupId}`).get()).data();
  if (!g) throw new Error('no such group');
  if (!(g.memberUids || []).includes(uid)) throw new Error('the new owner has to be a member first');
  await doc(`groups/${groupId}`).update({ ownerUid: uid });
}

/** Take a person out of a group, on both sides: the group and their own list. */
export async function removeMember(groupId, uid) {
  const g = (await doc(`groups/${groupId}`).get()).data();
  if (!g) throw new Error('no such group');
  if (g.ownerUid === uid) throw new Error('that is the owner — hand the group to someone else first');
  const w = writer();
  w.update(doc(`groups/${groupId}`), { memberUids: FV.arrayRemove(uid) });
  if ((await doc(`users/${uid}`).get()).exists) w.update(doc(`users/${uid}`), { groupIds: FV.arrayRemove(groupId) });
  await w.commit();
}

/** Mark a group as the directory, or as a playing group. */
export async function setKind(groupId, kind) {
  await doc(`groups/${groupId}`).update({ kind: kind === 'group' ? 'group' : FV.delete() });
}

/**
 * Delete a group. Its golfers stay (they are people, and may be in other
 * groups) — they just stop being in this one. Its rounds stay too, as the
 * creator's own rounds (groupId null), so nobody's history vanishes. Its
 * pending invitations are deleted.
 */
export async function deleteGroup(groupId) {
  const w = writer();
  for (const g of await where('golfers', 'poolGroupIds', 'array-contains', groupId)) {
    w.update(doc(`golfers/${g.id}`), { poolGroupIds: FV.arrayRemove(groupId) });
  }
  for (const u of await where('users', 'groupIds', 'array-contains', groupId)) {
    w.update(doc(`users/${u.id}`), { groupIds: FV.arrayRemove(groupId) });
  }
  const rounds = await where('rounds', 'groupId', '==', groupId);
  rounds.forEach((r) => w.update(doc(`rounds/${r.id}`), { groupId: null }));
  const invites = await where('invites', 'groupId', '==', groupId);
  invites.forEach((i) => w.delete(doc(`invites/${i.id}`)));
  w.delete(doc(`groups/${groupId}`));
  await w.commit();
  return { rounds: rounds.length, invites: invites.length };
}

/**
 * Fold one group into another — for the duplicate someone made by accident.
 * Golfers, members, rounds and invitations of `fromId` all move to `intoId`,
 * then `fromId` is deleted. The surviving group keeps its own name, owner and
 * join code.
 */
export async function mergeGroups(fromId, intoId) {
  if (fromId === intoId) throw new Error('pick two different groups');
  const from = (await doc(`groups/${fromId}`).get()).data();
  const into = (await doc(`groups/${intoId}`).get()).data();
  if (!from || !into) throw new Error('no such group');
  const w = writer();
  for (const g of await where('golfers', 'poolGroupIds', 'array-contains', fromId)) {
    w.update(doc(`golfers/${g.id}`), { poolGroupIds: uniq((g.poolGroupIds || []).map((x) => x === fromId ? intoId : x)) });
  }
  for (const u of await where('users', 'groupIds', 'array-contains', fromId)) {
    w.update(doc(`users/${u.id}`), { groupIds: uniq((u.groupIds || []).map((x) => x === fromId ? intoId : x)) });
  }
  const rounds = await where('rounds', 'groupId', '==', fromId);
  rounds.forEach((r) => w.update(doc(`rounds/${r.id}`), { groupId: intoId }));
  for (const i of await where('invites', 'groupId', '==', fromId)) {
    w.update(doc(`invites/${i.id}`), { groupId: intoId });
  }
  w.update(doc(`groups/${intoId}`), { memberUids: uniq([...(into.memberUids || []), ...(from.memberUids || [])]) });
  w.delete(doc(`groups/${fromId}`));
  await w.commit();
  return { rounds: rounds.length };
}

// ------------------------------------------------------------------- golfers

/** Name, GHIN number, index, aliases. Nothing that decides who can see him. */
export async function updateGolfer(golferId, fields) {
  const out = {};
  if ('name' in fields) {
    const nm = String(fields.name || '').trim();
    if (!nm) throw new Error('a golfer needs a name');
    out.name = nm;
  }
  if ('ghinNumber' in fields) out.ghinNumber = String(fields.ghinNumber || '').replace(/\D/g, '') || null;
  if ('currentIndex' in fields) {
    const v = String(fields.currentIndex == null ? '' : fields.currentIndex).trim();
    out.currentIndex = v === '' ? null : v;
  }
  if ('aliases' in fields) out.aliases = uniq((fields.aliases || []).map((a) => String(a).trim()));
  await doc(`golfers/${golferId}`).update(out);
}

export async function setGolferGroups(golferId, groupIds) {
  await doc(`golfers/${golferId}`).update({ poolGroupIds: uniq(groupIds) });
}

/**
 * Merge a duplicate golfer into the one to keep.
 *
 * This is the operation that matters most and is easiest to get wrong. A
 * golfer id is what every round and every standing is keyed by, so leaving
 * `dupId` anywhere splits that person's season in two. Rewritten:
 *   - every round listing him: golferIds, and the key of his results entry
 *   - users.myGolferId, invites.golferId, group contacts keyed by him
 *   - the kept record gains his groups, his aliases, and his name as an alias
 * A round that lists BOTH records is not touched and is reported instead: it
 * means two different people were scored in it, and merging would lose one.
 */
export async function mergeGolfers(dupId, keepId) {
  if (dupId === keepId) throw new Error('pick two different golfers');
  const dupSnap = await doc(`golfers/${dupId}`).get();
  const keepSnap = await doc(`golfers/${keepId}`).get();
  if (!dupSnap.exists || !keepSnap.exists) throw new Error('no such golfer');
  const dup = dupSnap.data(), keep = keepSnap.data();
  if (dup.claimedByUid && keep.claimedByUid && dup.claimedByUid !== keep.claimedByUid) {
    throw new Error('both records are claimed by different accounts — these look like two different people');
  }

  const w = writer();
  const conflicts = [];
  const rounds = await where('rounds', 'golferIds', 'array-contains', dupId);
  for (const r of rounds) {
    if ((r.golferIds || []).includes(keepId)) { conflicts.push(r.id); continue; }
    const results = { ...(r.results || {}) };
    if (results[dupId]) { results[keepId] = results[dupId]; delete results[dupId]; }
    w.update(doc(`rounds/${r.id}`), {
      golferIds: (r.golferIds || []).map((x) => x === dupId ? keepId : x),
      results,
    });
  }
  if (conflicts.length) {
    throw new Error(conflicts.length + ' round(s) list both of them — they look like two different people. Nothing was changed.');
  }

  for (const u of await where('users', 'myGolferId', '==', dupId)) {
    w.update(doc(`users/${u.id}`), { myGolferId: keepId });
  }
  for (const i of await where('invites', 'golferId', '==', dupId)) {
    w.update(doc(`invites/${i.id}`), { golferId: keepId });
  }
  // Every group, not just the ones he is in now: a contact is kept under the
  // group that added it, and he may have been taken out of that group since.
  for (const { id: gid } of await all('groups')) {
    const c = await doc(`groups/${gid}/contacts/${dupId}`).get();
    if (c.exists) {
      const k = await doc(`groups/${gid}/contacts/${keepId}`).get();
      if (!k.exists) w.set(doc(`groups/${gid}/contacts/${keepId}`), c.data());
      w.delete(doc(`groups/${gid}/contacts/${dupId}`));
    }
  }

  const merged = {
    poolGroupIds: uniq([...(keep.poolGroupIds || []), ...(dup.poolGroupIds || [])]),
    aliases: uniq([...(keep.aliases || []), ...(dup.aliases || []),
                   ...(dup.name && dup.name !== keep.name ? [dup.name] : [])]),
  };
  if (!keep.ghinNumber && dup.ghinNumber) merged.ghinNumber = dup.ghinNumber;
  if (!keep.currentIndex && dup.currentIndex) merged.currentIndex = dup.currentIndex;
  if (!keep.claimedByUid && dup.claimedByUid) {
    merged.claimedByUid = dup.claimedByUid;
    if (dup.claimedViaInviteId) merged.claimedViaInviteId = dup.claimedViaInviteId;
  }
  w.update(doc(`golfers/${keepId}`), merged);
  w.delete(doc(`golfers/${dupId}`));
  await w.commit();
  return { rounds: rounds.length };
}

/** Only a golfer who is in no round can be deleted outright; otherwise merge. */
export async function deleteGolfer(golferId) {
  const rounds = await where('rounds', 'golferIds', 'array-contains', golferId);
  if (rounds.length) throw new Error('he is in ' + rounds.length + ' round(s) — merge him into the right record instead');
  const w = writer();
  for (const u of await where('users', 'myGolferId', '==', golferId)) w.update(doc(`users/${u.id}`), { myGolferId: null });
  for (const i of await where('invites', 'golferId', '==', golferId)) w.update(doc(`invites/${i.id}`), { golferId: FV.delete() });
  w.delete(doc(`golfers/${golferId}`));
  await w.commit();
}

// --------------------------------------------------------------------- users

/**
 * Say which golfer an account is. Clears any other golfer that account had
 * claimed, so one person is never two records.
 */
export async function linkUserGolfer(uid, golferId) {
  const w = writer();
  for (const g of await where('golfers', 'claimedByUid', '==', uid)) {
    if (g.id !== golferId) w.update(doc(`golfers/${g.id}`), { claimedByUid: null, claimedViaInviteId: FV.delete() });
  }
  if (golferId) {
    const g = (await doc(`golfers/${golferId}`).get()).data();
    if (!g) throw new Error('no such golfer');
    if (g.claimedByUid && g.claimedByUid !== uid) throw new Error('that golfer is already linked to another account');
    w.update(doc(`golfers/${golferId}`), { claimedByUid: uid });
  }
  w.update(doc(`users/${uid}`), { myGolferId: golferId || null });
  await w.commit();
}

/** Put a person in a group, on both sides. */
export async function addMember(groupId, uid) {
  const w = writer();
  w.update(doc(`groups/${groupId}`), { memberUids: FV.arrayUnion(uid) });
  w.update(doc(`users/${uid}`), { groupIds: FV.arrayUnion(groupId) });
  await w.commit();
}

// -------------------------------------------------------------------- rounds

export async function setRoundGroup(roundId, groupId) {
  await doc(`rounds/${roundId}`).update({ groupId: groupId || null });
}

export async function deleteRound(roundId) {
  await doc(`rounds/${roundId}`).delete();
}

// ------------------------------------------------------------------- invites

export async function revokeInvite(inviteId) {
  await doc(`invites/${inviteId}`).update({ status: 'revoked' });
}

export async function deleteInvite(inviteId) {
  await doc(`invites/${inviteId}`).delete();
}
