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
  collection, query, where, getDocs,
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
  test('a stranger may append exactly themselves (invite acceptance)', async () => {
    await assertSucceeds(updateDoc(doc(stranger(), 'groups', GROUP_A), { memberUids: [BRIAN, MIKE, STRANGER] }));
  });
  test('a stranger may NOT append themselves and change the owner', async () => {
    await assertFails(updateDoc(doc(stranger(), 'groups', GROUP_A), { memberUids: [BRIAN, MIKE, STRANGER], ownerUid: STRANGER }));
  });
  test('a stranger may NOT append someone else too', async () => {
    await assertFails(updateDoc(doc(stranger(), 'groups', GROUP_A), { memberUids: [BRIAN, MIKE, STRANGER, 'uid_extra'] }));
  });
  test('non-owner cannot delete', async () => { await assertFails(deleteDoc(doc(mike(), 'groups', GROUP_A))); });
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
