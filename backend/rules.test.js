/**
 * Security rules tests, run against the Firestore emulator.
 *
 *   firebase emulators:start --only firestore --project bb-test
 *   node --test rules.test.js
 *
 * These assert the privacy model described in project docs 08/09/10. The point
 * is the DENY cases: a rule that only ever gets tested with the happy path is a
 * rule nobody has tested.
 */
import { test, before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} from '@firebase/rules-unit-testing';
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc,
  collection, query, where, getDocs, writeBatch,
} from 'firebase/firestore';

let env;

const BRIAN = 'uid_brian';
const MIKE  = 'uid_mike';
const STRANGER = 'uid_stranger';

const GROUP_A = 'grp_saturday';
const GROUP_B = 'grp_tuesday';

const G_BRIAN = 'ghin:1506580';
const G_DAVE  = 'ghin:1234567';   // a regular with NO account
const G_MIKE  = 'ghin:7654321';

function ctx(uid, token = {}) {
  return uid ? env.authenticatedContext(uid, token).firestore()
             : env.unauthenticatedContext().firestore();
}
const brian    = (t) => ctx(BRIAN, { email: 'brian@x.com', email_verified: true, ...t });
const mike     = (t) => ctx(MIKE,  { email: 'mike@x.com',  email_verified: true, ...t });
const stranger = () => ctx(STRANGER, { email: 'nope@x.com', email_verified: true });
const admin    = () => ctx('uid_admin', { admin: true });
const anon     = () => ctx(null);

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'bb-test',
    firestore: { rules: fs.readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8181 },
  });
});
after(async () => { await env?.cleanup(); });

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore();
    await setDoc(doc(db, 'users', BRIAN), { displayName: 'Brian', groupIds: [GROUP_A, GROUP_B], myGolferId: G_BRIAN });
    await setDoc(doc(db, 'users', MIKE),  { displayName: 'Mike',  groupIds: [GROUP_A],          myGolferId: G_MIKE });
    await setDoc(doc(db, 'users', STRANGER), { displayName: 'Stranger', groupIds: [] });

    await setDoc(doc(db, 'groups', GROUP_A), {
      name: 'Saturday', ownerUid: BRIAN, memberUids: [BRIAN, MIKE],
      poolGolferIds: [G_BRIAN, G_MIKE, G_DAVE],
    });
    await setDoc(doc(db, 'groups', GROUP_B), {
      name: 'Tuesday', ownerUid: BRIAN, memberUids: [BRIAN],
      poolGolferIds: [G_BRIAN],
    });

    await setDoc(doc(db, 'golfers', G_BRIAN), { name: 'Brian B', claimedByUid: BRIAN, discoverable: false, poolGroupIds: [GROUP_A, GROUP_B] });
    await setDoc(doc(db, 'golfers', G_MIKE),  { name: 'Mike M',  claimedByUid: MIKE,  discoverable: false, poolGroupIds: [GROUP_A] });
    // Dave: seeded, real person, no account, never will have one.
    await setDoc(doc(db, 'golfers', G_DAVE),  { name: 'Dave D',  claimedByUid: null,  discoverable: false, poolGroupIds: [GROUP_A], ghinNumber: '1234567' });

    await setDoc(doc(db, 'rounds', 'r_groupA'), { createdByUid: BRIAN, groupId: GROUP_A, golferIds: [G_BRIAN, G_MIKE, G_DAVE] });
    await setDoc(doc(db, 'rounds', 'r_groupB'), { createdByUid: BRIAN, groupId: GROUP_B, golferIds: [G_BRIAN] });
    await setDoc(doc(db, 'rounds', 'r_personal'), { createdByUid: BRIAN, groupId: null, golferIds: [G_BRIAN] });

    await setDoc(doc(db, 'groups', GROUP_A, 'contacts', G_DAVE), { name: 'Dave D', phone: '+15550001111' });
    await setDoc(doc(db, 'invites', 'inv_mike'), { groupId: GROUP_A, email: 'mike@x.com', invitedByUid: BRIAN, status: 'pending' });
    // Brian asserts: dave@x.com is the golfer ghin:1234567.
    await setDoc(doc(db, 'invites', 'inv_dave'), { groupId: GROUP_A, email: 'dave@x.com', golferId: G_DAVE, invitedByUid: BRIAN, status: 'pending' });
  });
});

describe('users are private', () => {
  test('own doc readable', async () => { await assertSucceeds(getDoc(doc(brian(), 'users', BRIAN))); });
  test('group-mate cannot read your user doc', async () => { await assertFails(getDoc(doc(mike(), 'users', BRIAN))); });
  test('anonymous cannot read', async () => { await assertFails(getDoc(doc(anon(), 'users', BRIAN))); });
  test('admin can read', async () => { await assertSucceeds(getDoc(doc(admin(), 'users', BRIAN))); });
});

describe('golfers: pool visibility, not a directory', () => {
  test('group-mate can read a golfer in a shared pool', async () => {
    await assertSucceeds(getDoc(doc(mike(), 'golfers', G_DAVE)));
  });
  test('stranger cannot read a non-discoverable golfer', async () => {
    await assertFails(getDoc(doc(stranger(), 'golfers', G_DAVE)));
  });
  test('stranger cannot list the golfers collection', async () => {
    await assertFails(getDocs(collection(stranger(), 'golfers')));
  });
  test('member can list their own pool', async () => {
    await assertSucceeds(getDocs(query(collection(mike(), 'golfers'),
      where('poolGroupIds', 'array-contains-any', [GROUP_A]))));
  });
  test('member cannot list a pool they are not in', async () => {
    await assertFails(getDocs(query(collection(mike(), 'golfers'),
      where('poolGroupIds', 'array-contains-any', [GROUP_B]))));
  });
});

describe('unclaimed golfers: maintainable, never publishable', () => {
  test('group-mate may fix an unclaimed golfer name', async () => {
    await assertSucceeds(updateDoc(doc(mike(), 'golfers', G_DAVE), { name: 'David D' }));
  });
  test('group-mate may NOT publish an unclaimed golfer', async () => {
    await assertFails(updateDoc(doc(mike(), 'golfers', G_DAVE), { discoverable: true }));
  });
  test('group-mate may NOT seize an unclaimed golfer', async () => {
    await assertFails(updateDoc(doc(mike(), 'golfers', G_DAVE), { claimedByUid: MIKE, name: 'Mine now' }));
  });
  test('group-mate may NOT grant themselves access via poolGroupIds', async () => {
    await assertFails(updateDoc(doc(mike(), 'golfers', G_DAVE), { poolGroupIds: [GROUP_A, GROUP_B] }));
  });
  test('nobody may edit a golfer claimed by someone else', async () => {
    await assertFails(updateDoc(doc(mike(), 'golfers', G_BRIAN), { name: 'Not Brian' }));
  });
  test('a golfer cannot be created already discoverable', async () => {
    await assertFails(setDoc(doc(brian(), 'golfers', 'ghin:9999999'),
      { name: 'X', claimedByUid: null, discoverable: true, poolGroupIds: [] }));
  });
});

describe('claiming requires proof, not just intent', () => {
  const dave = () => ctx('uid_dave', { email: 'dave@x.com', email_verified: true });

  test('Dave claims his own record via his invitation', async () => {
    await assertSucceeds(updateDoc(doc(dave(), 'golfers', G_DAVE),
      { claimedByUid: 'uid_dave', claimedViaInviteId: 'inv_dave' }));
  });
  test('a bare claim with no invitation is denied', async () => {
    await assertFails(updateDoc(doc(mike(), 'golfers', G_DAVE), { claimedByUid: MIKE }));
  });
  test('Mike cannot claim Dave using Dave\'s invitation', async () => {
    await assertFails(updateDoc(doc(mike(), 'golfers', G_DAVE),
      { claimedByUid: MIKE, claimedViaInviteId: 'inv_dave' }));
  });
  test('an invitation for a different golfer does not authorise the claim', async () => {
    await assertFails(updateDoc(doc(mike(), 'golfers', G_DAVE),
      { claimedByUid: MIKE, claimedViaInviteId: 'inv_mike' }));
  });
  test('unverified email cannot claim', async () => {
    const fake = env.authenticatedContext('uid_fake', { email: 'dave@x.com', email_verified: false }).firestore();
    await assertFails(updateDoc(doc(fake, 'golfers', G_DAVE),
      { claimedByUid: 'uid_fake', claimedViaInviteId: 'inv_dave' }));
  });
  test('admin may link a record directly (the seeding path)', async () => {
    await assertSucceeds(updateDoc(doc(admin(), 'golfers', G_DAVE), { claimedByUid: 'uid_dave' }));
  });
  test('owner may then publish their own record', async () => {
    await env.withSecurityRulesDisabled(async (c) =>
      setDoc(doc(c.firestore(), 'golfers', G_MIKE), { name: 'Mike M', claimedByUid: MIKE, discoverable: false, poolGroupIds: [GROUP_A] }));
    await assertSucceeds(updateDoc(doc(mike(), 'golfers', G_MIKE), { discoverable: true }));
  });
});

describe('rounds are scoped to what you can see', () => {
  test('member reads a round of their group', async () => {
    await assertSucceeds(getDoc(doc(mike(), 'rounds', 'r_groupA')));
  });
  test('member canNOT read a round of a group they are not in', async () => {
    await assertFails(getDoc(doc(mike(), 'rounds', 'r_groupB')));
  });
  test('member canNOT read a personal round of someone else', async () => {
    await assertFails(getDoc(doc(mike(), 'rounds', 'r_personal')));
  });
  test('LIST: group rounds — the group-stats query', async () => {
    await assertSucceeds(getDocs(query(collection(mike(), 'rounds'), where('groupId', '==', GROUP_A))));
  });
  test('LIST: own rounds — the personal-history query', async () => {
    await assertSucceeds(getDocs(query(collection(brian(), 'rounds'), where('createdByUid', '==', BRIAN))));
  });
  test('LIST: unconstrained query is denied', async () => {
    await assertFails(getDocs(collection(mike(), 'rounds')));
  });
  test('LIST: cannot query another group’s rounds', async () => {
    await assertFails(getDocs(query(collection(mike(), 'rounds'), where('groupId', '==', GROUP_B))));
  });
  test('cannot create a round attributed to someone else', async () => {
    await assertFails(setDoc(doc(mike(), 'rounds', 'r_new'), { createdByUid: BRIAN, groupId: GROUP_A, golferIds: [] }));
  });
  test('cannot file a round into a group you are not in', async () => {
    await assertFails(setDoc(doc(mike(), 'rounds', 'r_new'), { createdByUid: MIKE, groupId: GROUP_B, golferIds: [] }));
  });
  test('personal round with no group is allowed', async () => {
    await assertSucceeds(setDoc(doc(mike(), 'rounds', 'r_new'), { createdByUid: MIKE, groupId: null, golferIds: [] }));
  });
});

describe('groups', () => {
  test('member reads their group', async () => { await assertSucceeds(getDoc(doc(mike(), 'groups', GROUP_A))); });
  test('non-member cannot read', async () => { await assertFails(getDoc(doc(stranger(), 'groups', GROUP_A))); });
  test('member may edit the pool', async () => {
    await assertSucceeds(updateDoc(doc(mike(), 'groups', GROUP_A), { poolGolferIds: [G_BRIAN, G_MIKE, G_DAVE, 'ghin:1111111'] }));
  });
  test('member may NOT add another person to membership', async () => {
    await assertFails(updateDoc(doc(mike(), 'groups', GROUP_A), { memberUids: [BRIAN, MIKE, STRANGER] }));
  });
  test('owner may change membership', async () => {
    await assertSucceeds(updateDoc(doc(brian(), 'groups', GROUP_A), { memberUids: [BRIAN, MIKE, STRANGER] }));
  });
  test('a stranger may NOT append themselves with no proof (knowing the id is not enough)', async () => {
    await assertFails(updateDoc(doc(stranger(), 'groups', GROUP_A), { memberUids: [BRIAN, MIKE, STRANGER] }));
  });
  test('a stranger may NOT append themselves and change the owner', async () => {
    await assertFails(updateDoc(doc(stranger(), 'groups', GROUP_A), { memberUids: [BRIAN, MIKE, STRANGER], ownerUid: STRANGER }));
  });
  test('a stranger may NOT append someone else too', async () => {
    await assertFails(updateDoc(doc(stranger(), 'groups', GROUP_A), { memberUids: [BRIAN, MIKE, STRANGER, 'uid_extra'] }));
  });
  test('the owner may hand the group to another member', async () => {
    await assertSucceeds(updateDoc(doc(brian(), 'groups', GROUP_A), { ownerUid: MIKE }));
  });
  test('but not to someone outside it', async () => {
    await assertFails(updateDoc(doc(brian(), 'groups', GROUP_A), { ownerUid: STRANGER }));
  });
  test('non-owner cannot delete', async () => { await assertFails(deleteDoc(doc(mike(), 'groups', GROUP_A))); });
  test('a member may NOT make themselves owner', async () => {
    await assertFails(updateDoc(doc(mike(), 'groups', GROUP_A), { ownerUid: MIKE }));
  });
  test('a member may NOT change the join code', async () => {
    await assertFails(updateDoc(doc(mike(), 'groups', GROUP_A), { joinCode: 'mine' }));
  });
});

describe('joining a group needs proof', () => {
  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (c) =>
      updateDoc(doc(c.firestore(), 'groups', GROUP_B), { kind: 'group', joinCode: 'secret-b' }));
  });
  test('the join code from the share link lets you in', async () => {
    await assertSucceeds(updateDoc(doc(stranger(), 'groups', GROUP_B),
      { memberUids: [BRIAN, STRANGER], joinProof: 'secret-b' }));
  });
  test('a wrong code does not', async () => {
    await assertFails(updateDoc(doc(stranger(), 'groups', GROUP_B),
      { memberUids: [BRIAN, STRANGER], joinProof: 'guess' }));
  });
  test('a group with no code cannot be joined by code at all', async () => {
    await assertFails(updateDoc(doc(stranger(), 'groups', GROUP_A),
      { memberUids: [BRIAN, MIKE, STRANGER], joinProof: '' }));
  });
  test('the right code does not let you add someone else', async () => {
    await assertFails(updateDoc(doc(stranger(), 'groups', GROUP_B),
      { memberUids: [BRIAN, STRANGER, 'uid_extra'], joinProof: 'secret-b' }));
  });
  test('the right code does not let you rename the group on the way in', async () => {
    await assertFails(updateDoc(doc(stranger(), 'groups', GROUP_B),
      { memberUids: [BRIAN, STRANGER], joinProof: 'secret-b', name: 'Mine' }));
  });
  test('the owner changing the code kills the old link', async () => {
    await assertSucceeds(updateDoc(doc(brian(), 'groups', GROUP_B), { joinCode: 'new-code' }));
    await assertFails(updateDoc(doc(stranger(), 'groups', GROUP_B),
      { memberUids: [BRIAN, STRANGER], joinProof: 'secret-b' }));
  });
  test('an emailed invitation to that group lets the invitee in', async () => {
    const dave = ctx('uid_dave', { email: 'dave@x.com', email_verified: true });
    await assertSucceeds(updateDoc(doc(dave, 'groups', GROUP_A),
      { memberUids: [BRIAN, MIKE, 'uid_dave'], joinInvite: 'inv_dave' }));
  });
  test('someone else\'s invitation does not', async () => {
    await assertFails(updateDoc(doc(stranger(), 'groups', GROUP_A),
      { memberUids: [BRIAN, MIKE, STRANGER], joinInvite: 'inv_dave' }));
  });
  test('an invitation to a different group does not', async () => {
    const dave = ctx('uid_dave', { email: 'dave@x.com', email_verified: true });
    await assertFails(updateDoc(doc(dave, 'groups', GROUP_B),
      { memberUids: [BRIAN, 'uid_dave'], joinInvite: 'inv_dave' }));
  });
  test('a member may leave', async () => {
    await assertSucceeds(updateDoc(doc(mike(), 'groups', GROUP_A), { memberUids: [BRIAN] }));
  });
  test('but may not take anyone else with them', async () => {
    await assertFails(updateDoc(doc(mike(), 'groups', GROUP_A), { memberUids: [] }));
  });
  test('the owner cannot leave their own group', async () => {
    await env.withSecurityRulesDisabled(async (c) =>
      updateDoc(doc(c.firestore(), 'groups', GROUP_A), { ownerUid: MIKE }));
    await assertFails(updateDoc(doc(mike(), 'groups', GROUP_A), { memberUids: [BRIAN] }));
  });
});

describe('starting a group', () => {
  test('anyone may start a playing group they own', async () => {
    await assertSucceeds(setDoc(doc(stranger(), 'groups', 'grp_new'),
      { name: 'Wednesday', ownerUid: STRANGER, memberUids: [STRANGER], kind: 'group', joinCode: 'x' }));
  });
  test('not one owned by somebody else', async () => {
    await assertFails(setDoc(doc(stranger(), 'groups', 'grp_new'),
      { name: 'Wednesday', ownerUid: BRIAN, memberUids: [STRANGER], kind: 'group' }));
  });
  test('not a directory', async () => {
    await assertFails(setDoc(doc(stranger(), 'groups', 'grp_new'),
      { name: 'Everyone', ownerUid: STRANGER, memberUids: [STRANGER], kind: 'directory' }));
  });
});

describe('your group list only holds groups you are really in', () => {
  test('a new account starts in no groups', async () => {
    await assertFails(setDoc(doc(ctx('uid_new'), 'users', 'uid_new'), { groupIds: [GROUP_A] }));
    await assertSucceeds(setDoc(doc(ctx('uid_new'), 'users', 'uid_new'), { groupIds: [] }));
  });
  test('you cannot write yourself into a group you are not in', async () => {
    await assertFails(updateDoc(doc(stranger(), 'users', STRANGER), { groupIds: [GROUP_A] }));
  });
  test('so that trick no longer reads the group\'s golfers', async () => {
    await updateDoc(doc(stranger(), 'users', STRANGER), { groupIds: [GROUP_A] }).catch(() => {});
    await assertFails(getDoc(doc(stranger(), 'golfers', G_DAVE)));
  });
  test('joining and recording it in one batch works', async () => {
    await env.withSecurityRulesDisabled(async (c) =>
      updateDoc(doc(c.firestore(), 'groups', GROUP_B), { kind: 'group', joinCode: 'secret-b' }));
    const db = stranger();
    const b = writeBatch(db);
    b.update(doc(db, 'groups', GROUP_B), { memberUids: [BRIAN, STRANGER], joinProof: 'secret-b' });
    b.update(doc(db, 'users', STRANGER), { groupIds: [GROUP_B] });
    await assertSucceeds(b.commit());
  });
  test('dropping a group from your own list is always allowed', async () => {
    await assertSucceeds(updateDoc(doc(mike(), 'users', MIKE), { groupIds: [] }));
  });
  test('you may still edit the rest of your own doc', async () => {
    await assertSucceeds(updateDoc(doc(mike(), 'users', MIKE), { displayName: 'Michael' }));
  });
});

describe('building a playing group from the directory', () => {
  // GROUP_A is the directory (no kind). GROUP_P is a playing group Mike and
  // Brian are in; the stranger is in neither.
  const GROUP_P = 'grp_wednesday';
  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (c) => {
      const db = c.firestore();
      await setDoc(doc(db, 'groups', GROUP_P), { name: 'Wednesday', ownerUid: MIKE, memberUids: [MIKE, BRIAN], kind: 'group' });
      await updateDoc(doc(db, 'users', MIKE), { groupIds: [GROUP_A, GROUP_P] });
    });
  });
  test('a member adds a directory golfer to their playing group', async () => {
    await assertSucceeds(updateDoc(doc(mike(), 'golfers', G_DAVE), { poolGroupIds: [GROUP_A, GROUP_P] }));
  });
  test('including one who has claimed his record', async () => {
    await assertSucceeds(updateDoc(doc(mike(), 'golfers', G_BRIAN), { poolGroupIds: [GROUP_A, GROUP_B, GROUP_P] }));
  });
  test('but not into a group they are not in', async () => {
    await assertFails(updateDoc(doc(mike(), 'golfers', G_DAVE), { poolGroupIds: [GROUP_A, GROUP_B] }));
  });
  test('and not a golfer they cannot see', async () => {
    await env.withSecurityRulesDisabled(async (c) =>
      setDoc(doc(c.firestore(), 'golfers', 'ghin:5555555'), { name: 'Hidden', claimedByUid: null, discoverable: false, poolGroupIds: [GROUP_B] }));
    await assertFails(updateDoc(doc(mike(), 'golfers', 'ghin:5555555'), { poolGroupIds: [GROUP_B, GROUP_P] }));
  });
  test('and not while changing anything else about him', async () => {
    await assertFails(updateDoc(doc(mike(), 'golfers', G_BRIAN), { poolGroupIds: [GROUP_A, GROUP_B, GROUP_P], name: 'X' }));
  });
  test('a member takes a golfer back out of their playing group', async () => {
    await env.withSecurityRulesDisabled(async (c) =>
      updateDoc(doc(c.firestore(), 'golfers', G_DAVE), { poolGroupIds: [GROUP_A, GROUP_P] }));
    await assertSucceeds(updateDoc(doc(mike(), 'golfers', G_DAVE), { poolGroupIds: [GROUP_A] }));
  });
  test('but nobody takes a golfer out of the directory', async () => {
    await assertFails(updateDoc(doc(mike(), 'golfers', G_DAVE), { poolGroupIds: [] }));
  });
  test('a new golfer may be created into your own groups', async () => {
    await assertSucceeds(setDoc(doc(mike(), 'golfers', 'guest:newbie'),
      { name: 'New Guy', claimedByUid: null, discoverable: false, poolGroupIds: [GROUP_A, GROUP_P] }));
  });
  test('but not into a group you are not in', async () => {
    await assertFails(setDoc(doc(mike(), 'golfers', 'guest:newbie'),
      { name: 'New Guy', claimedByUid: null, discoverable: false, poolGroupIds: [GROUP_B] }));
  });
  test('nor into no group at all', async () => {
    await assertFails(setDoc(doc(mike(), 'golfers', 'guest:newbie'),
      { name: 'New Guy', claimedByUid: null, discoverable: false, poolGroupIds: [] }));
  });
});

describe('group contacts (phone numbers)', () => {
  test('member reads a contact', async () => {
    await assertSucceeds(getDoc(doc(mike(), 'groups', GROUP_A, 'contacts', G_DAVE)));
  });
  test('non-member cannot read a contact', async () => {
    await assertFails(getDoc(doc(stranger(), 'groups', GROUP_A, 'contacts', G_DAVE)));
  });
});

describe('invites', () => {
  test('invitee sees an invite addressed to them', async () => {
    await assertSucceeds(getDocs(query(collection(mike(), 'invites'), where('email', '==', 'mike@x.com'))));
  });
  test('someone else cannot read it', async () => {
    await assertFails(getDoc(doc(stranger(), 'invites', 'inv_mike')));
  });
  test('unverified email cannot match an invite', async () => {
    const unverified = env.authenticatedContext('uid_fake', { email: 'mike@x.com', email_verified: false }).firestore();
    await assertFails(getDoc(doc(unverified, 'invites', 'inv_mike')));
  });
  test('invitee may accept', async () => {
    await assertSucceeds(updateDoc(doc(mike(), 'invites', 'inv_mike'), { status: 'accepted' }));
  });
  test('invitee may not revoke', async () => {
    await assertFails(updateDoc(doc(mike(), 'invites', 'inv_mike'), { status: 'revoked' }));
  });
  test('non-member cannot create an invite to a group', async () => {
    await assertFails(setDoc(doc(stranger(), 'invites', 'inv_x'),
      { groupId: GROUP_A, email: 'x@x.com', invitedByUid: STRANGER, status: 'pending' }));
  });
});

describe('courses are public to read, admin-only to write', () => {
  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (c) =>
      setDoc(doc(c.firestore(), 'courses', 'el-macero'), { name: 'El Macero', par: [], hcp: [] }));
  });
  test('anyone may read a course, signed in or not', async () => {
    await assertSucceeds(getDoc(doc(anon(), 'courses', 'el-macero')));
    await assertSucceeds(getDocs(collection(anon(), 'courses')));
  });
  test('a signed-in member may not change one', async () => {
    await assertFails(updateDoc(doc(brian(), 'courses', 'el-macero'), { name: 'Mine' }));
  });
  test('nor add one', async () => {
    await assertFails(setDoc(doc(mike(), 'courses', 'new'), { name: 'New' }));
  });
  test('the admin may', async () => {
    await assertSucceeds(updateDoc(doc(admin(), 'courses', 'el-macero'), { name: 'El Macero CC' }));
    await assertSucceeds(setDoc(doc(admin(), 'courses', 'new'), { name: 'New' }));
  });
});

describe('inviteCodes are not enumerable', () => {
  test('signed-in user may read a code they know', async () => {
    await env.withSecurityRulesDisabled(async (c) =>
      setDoc(doc(c.firestore(), 'inviteCodes', 'ABCD'), { groupId: GROUP_A, active: true }));
    await assertSucceeds(getDoc(doc(mike(), 'inviteCodes', 'ABCD')));
  });
  test('nobody may list them', async () => {
    await assertFails(getDocs(collection(mike(), 'inviteCodes')));
  });
});
