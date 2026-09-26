/**
 * Bunch Bets — cloud layer (auth + Firestore).
 *
 * This is the "bridge only" architecture agreed in project doc 01 §3: new
 * backend code lives in its own module, the existing 9,300-line index.html is
 * grandfathered, and the two meet at `window.BB`. Nothing in here reaches into
 * the app; the app calls in.
 *
 * Loading it does nothing on its own — no sign-in prompt, no network, no writes
 * — until `BB.cloud.init()` is called. The app must keep working with this file
 * absent, failing, or offline. Cloud is the durability layer, never a
 * dependency for playing a round.
 *
 * Uses the Firebase *compat* SDK because index.html already loads compat for
 * the Realtime Database live-sync, and mixing SDK styles on one page is a
 * reliable way to end up with two Firebase apps and a confusing bug.
 */

const BB = (window.BB = window.BB || {});

const state = {
  app: null,
  auth: null,
  db: null,
  user: null,
  userDoc: null,
  ready: false,
  listeners: new Set(),
};

function assertReady() {
  if (!state.ready) throw new Error('BB.cloud.init() has not been called');
}
function requireUser() {
  assertReady();
  if (!state.user) throw new Error('not signed in');
  return state.user;
}

/**
 * Firestore rejects undefined; strip it rather than throw deep inside a write.
 *
 * Only PLAIN objects are recursed into. FieldValue sentinels (arrayUnion,
 * serverTimestamp) are class instances, and rebuilding one as a plain object
 * silently destroys it — the write then stores a meaningless `{}` where an
 * array should be. That bug shipped into the first draft of this file and was
 * caught by the integration test, not by reading it.
 */
const isPlainObject = (v) =>
  v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;

function clean(obj) {
  if (Array.isArray(obj)) return obj.map(clean);
  if (isPlainObject(obj)) {
    const out = {};
    for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = clean(v);
    return out;
  }
  return obj;   // sentinels, Dates, primitives — pass through untouched
}

const golferIdForGhin = (ghin) => `ghin:${String(ghin).replace(/\D/g, '')}`;

/** An unguessable code for a group's share link. Knowing it is the grant. */
function randomCode(len = 12) {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  const buf = new Uint32Array(len);
  crypto.getRandomValues(buf);
  return Array.from(buf, (n) => chars[n % chars.length]).join('');
}

/**
 * A group from before groups had a kind is the DIRECTORY: everyone this set of
 * people plays with. Playing groups — the Wednesday game, the Saturday money
 * game — are built from it and carry kind 'group'.
 */
const isDirectory = (group) => (group && group.kind) !== 'group';

/**
 * A handicap index from GHIN is a STRING and is not always a number: "NH" means
 * no established handicap, and plus handicaps arrive as "+2.8". Both appear in
 * the real roster. Anything that parseFloats these blindly produces NaN and
 * silently poisons a Course Handicap.
 */
function parseIndex(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s || s.toUpperCase() === 'NH') return null;
  const n = parseFloat(s.startsWith('+') ? '-' + s.slice(1) : s);
  return Number.isFinite(n) ? n : null;
}

BB.cloud = {
  golferIdForGhin,
  parseIndex,
  isDirectory,

  /** @param {object} config Firebase web config. @param {object} [opts] {emulator:{authUrl,firestoreHost,firestorePort}} */
  init(config, opts = {}) {
    if (state.ready) return state;
    if (typeof firebase === 'undefined') throw new Error('Firebase SDK not loaded');

    state.app = firebase.apps.find((a) => a.name === 'bbcloud')
             || firebase.initializeApp(config, 'bbcloud');
    state.auth = state.app.auth();
    state.db = state.app.firestore();

    if (opts.emulator) {
      state.auth.useEmulator(opts.emulator.authUrl, { disableWarnings: true });
      state.db.useEmulator(opts.emulator.firestoreHost, opts.emulator.firestorePort);
    }

    state.auth.onAuthStateChanged(async (user) => {
      state.user = user || null;
      state.userDoc = null;
      if (user) { try { state.userDoc = await BB.cloud.ensureUserDoc(); } catch (e) { /* offline */ } }
      state.listeners.forEach((fn) => { try { fn(state.user, state.userDoc); } catch (e) {} });
    });

    state.ready = true;
    return state;
  },

  onUserChanged(fn) { state.listeners.add(fn); return () => state.listeners.delete(fn); },
  currentUser() { return state.user; },
  isSignedIn() { return !!state.user; },

  // ------------------------------------------------------------------ auth
  async signInWithGoogle({ redirect = true } = {}) {
    assertReady();
    const provider = new firebase.auth.GoogleAuthProvider();
    // Redirect is the verified-working path on an installed iOS PWA (doc 06).
    // Popup is offered for desktop, where it is the smoother flow.
    return redirect ? state.auth.signInWithRedirect(provider)
                    : state.auth.signInWithPopup(provider);
  },

  /** Resolve a pending redirect. Safe to call on every load. */
  async completeRedirect() {
    assertReady();
    try { return await state.auth.getRedirectResult(); } catch (e) { return { error: e }; }
  },

  async sendSignInLink(email, continueUrl) {
    assertReady();
    await state.auth.sendSignInLinkToEmail(email, { url: continueUrl || location.href, handleCodeInApp: true });
    try { localStorage.setItem('bb-signin-email', email); } catch (e) {}
  },

  /** Call on load; completes an email-link sign-in if this URL is one. */
  async completeSignInLink() {
    assertReady();
    if (!state.auth.isSignInWithEmailLink(location.href)) return null;
    let email = null;
    try { email = localStorage.getItem('bb-signin-email'); } catch (e) {}
    if (!email) email = window.prompt('Confirm the email address you used');
    if (!email) return null;
    const res = await state.auth.signInWithEmailLink(email, location.href);
    try { localStorage.removeItem('bb-signin-email'); } catch (e) {}
    return res;
  },

  // --------------------------------------------------------- email + password
  //
  // Not everyone has a Google account. Email-LINK sign-in was ruled out: on an
  // iPhone the emailed link opens in Safari, which has its own storage, so the
  // person ends up signed in to Safari and still signed out of the home-screen
  // app. A password is typed into the app itself, so the session lands where
  // it is used. The two emails Firebase sends — verify, and reset — only
  // change state on the server, so it does not matter where they are opened.

  /** New account: create it, name it, and send the verify-your-email mail. */
  async signUpWithEmail(email, password, name) {
    assertReady();
    const cred = await state.auth.createUserWithEmailAndPassword(String(email || '').trim(), password);
    const nm = String(name || '').trim();
    if (nm) {
      await cred.user.updateProfile({ displayName: nm });
      // onAuthStateChanged has usually made the user doc already, before the
      // name was set, so put the name there too.
      try {
        await BB.cloud.ensureUserDoc();
        await state.db.doc(`users/${cred.user.uid}`).update({ displayName: nm });
      } catch (e) { /* offline: the name is on the auth profile regardless */ }
    }
    try { await cred.user.sendEmailVerification(); } catch (e) { /* can be resent */ }
    return cred.user;
  },

  async signInWithEmail(email, password) {
    assertReady();
    return (await state.auth.signInWithEmailAndPassword(String(email || '').trim(), password)).user;
  },

  async sendPasswordReset(email) {
    assertReady();
    await state.auth.sendPasswordResetEmail(String(email || '').trim());
  },

  async resendVerification() {
    const user = requireUser();
    await user.sendEmailVerification();
  },

  /**
   * Has the address been verified since? The verify link is usually opened in
   * Mail or Safari, not here, so the app has to ask. A fresh ID token is what
   * carries email_verified to the security rules — reload() alone is not enough.
   */
  async refreshVerified() {
    const user = requireUser();
    await user.reload();
    if (state.auth.currentUser && state.auth.currentUser.emailVerified) {
      await state.auth.currentUser.getIdToken(true);
    }
    state.user = state.auth.currentUser;
    return !!(state.user && state.user.emailVerified);
  },

  signOut() { assertReady(); return state.auth.signOut(); },

  // ------------------------------------------------------------- bootstrap
  /** Create users/{uid} on first sign-in. Idempotent. */
  async ensureUserDoc() {
    const user = requireUser();
    const ref = state.db.doc(`users/${user.uid}`);
    const snap = await ref.get();
    if (!snap.exists) {
      await ref.set(clean({
        displayName: user.displayName || '',
        email: (user.email || '').toLowerCase(),
        photoURL: user.photoURL || null,
        groupIds: [],
        myGolferId: null,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      }));
      return (await ref.get()).data();
    }
    return snap.data();
  },

  async myUserDoc() {
    const user = requireUser();
    return (await state.db.doc(`users/${user.uid}`).get()).data() || null;
  },

  // --------------------------------------------------------------- invites
  /**
   * Invitations addressed to this account's verified email. This is the durable
   * half of onboarding (doc 09 §3): it survives an auth redirect, an install,
   * and iOS discarding the query string when it launches at start_url.
   */
  async pendingInvites() {
    const user = requireUser();
    // The rules only match invitations against a VERIFIED address. Asking with
    // an unverified one is refused, which would fail the whole profile load
    // for anyone who signed up with a password and has not clicked the link.
    if (!user.email || !user.emailVerified) return [];
    const qs = await state.db.collection('invites')
      .where('email', '==', user.email.toLowerCase())
      .where('status', '==', 'pending')
      .get();
    return qs.docs.map((d) => ({ id: d.id, ...d.data() }));
  },

  /**
   * Accept an invitation: join the group, and claim the golfer record it names.
   *
   * The claim is the security-critical half. Rules will only allow it when the
   * invitation names this exact golfer AND is addressed to a verified email —
   * because "claim my own record" and "seize someone else's" are otherwise
   * byte-identical writes (doc 11).
   */
  async acceptInvite(inviteId) {
    const user = requireUser();
    const inviteRef = state.db.doc(`invites/${inviteId}`);
    const invite = (await inviteRef.get()).data();
    if (!invite) throw new Error('invitation not found');
    if (invite.email !== (user.email || '').toLowerCase()) throw new Error('invitation is for a different address');

    const batch = state.db.batch();
    const arrayUnion = firebase.firestore.FieldValue.arrayUnion;

    // joinInvite is the proof the rules ask for: without it, appending yourself
    // to a group is refused (anyone could otherwise join by knowing the id).
    batch.update(state.db.doc(`groups/${invite.groupId}`),
      { memberUids: arrayUnion(user.uid), joinInvite: inviteId });
    batch.update(state.db.doc(`users/${user.uid}`), clean({
      groupIds: arrayUnion(invite.groupId),
      myGolferId: invite.golferId || undefined,
    }));
    if (invite.golferId) {
      batch.update(state.db.doc(`golfers/${invite.golferId}`),
        { claimedByUid: user.uid, claimedViaInviteId: inviteId });
    }
    batch.update(inviteRef, { status: 'accepted' });

    await batch.commit();
    return { groupId: invite.groupId, golferId: invite.golferId || null };
  },

  // --------------------------------------------------------------- golfers
  async myGolfer() {
    const doc = await BB.cloud.myUserDoc();
    if (!doc?.myGolferId) return null;
    const snap = await state.db.doc(`golfers/${doc.myGolferId}`).get();
    return snap.exists ? { id: snap.id, ...snap.data() } : null;
  },

  /**
   * The group's regulars. Most have no account and never will — they are
   * golfers, not users. This is a list, not a search: rules confine it to pools
   * the caller belongs to, so `golfers` never behaves like a directory.
   */
  async groupPool(groupId) {
    requireUser();
    const qs = await state.db.collection('golfers')
      .where('poolGroupIds', 'array-contains', groupId)
      .get();
    return qs.docs.map((d) => ({ id: d.id, ...d.data() }));
  },

  /**
   * Record what this group actually calls someone. Aliases live on the golfer
   * record rather than on one phone, so linking a name once helps everybody and
   * survives a lost device.
   *
   * The rules permit this two ways: you may change your own claimed record, and
   * a group-mate may MAINTAIN an unclaimed one — which an alias is, since it
   * touches neither `discoverable`, `claimedByUid`, nor `poolGroupIds` (doc 11).
   */
  async addAlias(golferId, alias) {
    requireUser();
    const name = String(alias || '').trim();
    if (!name) return;
    await state.db.doc(`golfers/${golferId}`).update({
      aliases: firebase.firestore.FieldValue.arrayUnion(name),
    });
  },

  // ---------------------------------------------------------------- groups
  /**
   * Start a playing group: you own it, you are its only member, and it has a
   * join code for the share link. Golfers are added after it exists, because
   * the rules check membership of the group a golfer is being put into.
   */
  async createGroup(name, golferIds = []) {
    const user = requireUser();
    const clean_ = String(name || '').trim();
    if (!clean_) throw new Error('a group needs a name');
    const ref = state.db.collection('groups').doc();
    await ref.set({
      name: clean_,
      kind: 'group',
      ownerUid: user.uid,
      memberUids: [user.uid],
      joinCode: randomCode(),
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    await state.db.doc(`users/${user.uid}`).update({
      groupIds: firebase.firestore.FieldValue.arrayUnion(ref.id),
    });
    await BB.cloud.addToGroup(ref.id, golferIds);
    return ref.id;
  },

  /**
   * Put golfers in a group. One write per golfer: the rules allow a golfer to
   * gain exactly one group per write, and a batch would fail as a whole on
   * the first one that is refused.
   */
  async addToGroup(groupId, golferIds = []) {
    requireUser();
    const arrayUnion = firebase.firestore.FieldValue.arrayUnion;
    let added = 0;
    for (const id of golferIds) {
      await state.db.doc(`golfers/${id}`).update({ poolGroupIds: arrayUnion(groupId) });
      added++;
    }
    return added;
  },

  /** Take a golfer out of a playing group. The directory refuses this. */
  async removeFromGroup(groupId, golferId) {
    requireUser();
    await state.db.doc(`golfers/${golferId}`).update({
      poolGroupIds: firebase.firestore.FieldValue.arrayRemove(groupId),
    });
  },

  /**
   * Someone nobody has entered yet. With a GHIN number the record is keyed by
   * it, so the index refresh finds him; without one he is a guest. Either way
   * he goes into the groups given, which must all be the caller's.
   */
  async createGolfer({ name, ghinNumber = null, currentIndex = null }, groupIds) {
    requireUser();
    const nm = String(name || '').trim();
    if (!nm) throw new Error('a golfer needs a name');
    const ghin = ghinNumber ? String(ghinNumber).replace(/\D/g, '') : '';
    const id = ghin ? golferIdForGhin(ghin) : `guest:${randomCode(10)}`;
    try {
      await state.db.doc(`golfers/${id}`).set(clean({
        name: nm,
        ghinNumber: ghin || null,
        currentIndex: currentIndex == null || currentIndex === '' ? null : String(currentIndex),
        claimedByUid: null,
        discoverable: false,
        poolGroupIds: groupIds,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      }));
    } catch (e) {
      // A GHIN already on file belongs to a record this account cannot see, so
      // the write lands as an update to it and is refused.
      if (ghin && /permission/i.test(e.code || e.message)) {
        throw new Error('GHIN ' + ghin + ' is already on file with another group');
      }
      throw e;
    }
    return id;
  },

  /**
   * Join from a share link. The group is unreadable until you are in it, so
   * this cannot look anything up first — the code is presented, and the rules
   * decide. Recorded on the user doc in the same batch.
   */
  async joinGroup(groupId, code) {
    const user = requireUser();
    const arrayUnion = firebase.firestore.FieldValue.arrayUnion;
    const batch = state.db.batch();
    batch.update(state.db.doc(`groups/${groupId}`),
      { memberUids: arrayUnion(user.uid), joinProof: String(code || '') });
    batch.update(state.db.doc(`users/${user.uid}`), { groupIds: arrayUnion(groupId) });
    await batch.commit();
    const snap = await state.db.doc(`groups/${groupId}`).get();
    return { id: snap.id, ...snap.data() };
  },

  /**
   * The join code for a share link. A group made before share links has none;
   * its owner gets one made on first ask, and nobody else can make one.
   */
  async joinCodeFor(groupId) {
    const user = requireUser();
    const ref = state.db.doc(`groups/${groupId}`);
    const g = (await ref.get()).data() || {};
    if (g.joinCode) return g.joinCode;
    if (g.ownerUid !== user.uid) return null;
    const code = randomCode();
    await ref.update({ joinCode: code });
    return code;
  },

  /** Owner only: a new code, so every link sent out before stops working. */
  async resetJoinCode(groupId) {
    requireUser();
    const code = randomCode();
    await state.db.doc(`groups/${groupId}`).update({ joinCode: code });
    return code;
  },

  async renameGroup(groupId, name) {
    requireUser();
    const nm = String(name || '').trim();
    if (!nm) throw new Error('a group needs a name');
    await state.db.doc(`groups/${groupId}`).update({ name: nm });
  },

  async leaveGroup(groupId) {
    const user = requireUser();
    const arrayRemove = firebase.firestore.FieldValue.arrayRemove;
    await state.db.doc(`groups/${groupId}`).update({ memberUids: arrayRemove(user.uid) });
    await state.db.doc(`users/${user.uid}`).update({ groupIds: arrayRemove(groupId) });
  },

  async myGroups() {
    const doc = await BB.cloud.myUserDoc();
    const ids = doc?.groupIds || [];
    const snaps = await Promise.all(ids.map((id) => state.db.doc(`groups/${id}`).get()));
    return snaps.filter((s) => s.exists).map((s) => ({ id: s.id, ...s.data() }));
  },

  // ---------------------------------------------------------------- rounds
  /** @param {object} round {groupId|null, date, courseName, golferIds, games, results, ...} */
  async saveRound(round) {
    const user = requireUser();
    const ref = round.id ? state.db.doc(`rounds/${round.id}`) : state.db.collection('rounds').doc();
    const payload = clean({
      ...round,
      id: undefined,
      groupId: round.groupId ?? null,
      createdByUid: user.uid,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    // A full replace, NOT { merge: true }.
    //
    // merge replaces arrays wholesale but deep-merges maps, and `results` is a
    // map keyed by golfer id. So re-saving a round after linking "Bunch" to
    // ghin:1506580 updated golferIds correctly while leaving the old
    // results['guest:bunch'] entry sitting beside the new one — and every
    // standing that player appeared in silently doubled. Nothing threw; the
    // round listed correctly; only adding the numbers up revealed it.
    //
    // A round is a snapshot the client owns in full. There are no server-owned
    // fields to protect here, so a plain set is both correct and idempotent.
    await ref.set(payload);
    return ref.id;
  },

  /**
   * Two deliberately separate queries, not one. Firestore evaluates list rules
   * against the query, which has to be provably safe, so "mine OR my group's"
   * cannot be expressed as a single request (doc 11).
   */
  async myRounds(limit = 50) {
    const user = requireUser();
    const qs = await state.db.collection('rounds')
      .where('createdByUid', '==', user.uid).limit(limit).get();
    return qs.docs.map((d) => ({ id: d.id, ...d.data() }));
  },

  async groupRounds(groupId, limit = 200) {
    requireUser();
    const qs = await state.db.collection('rounds')
      .where('groupId', '==', groupId).limit(limit).get();
    return qs.docs.map((d) => ({ id: d.id, ...d.data() }));
  },

  // ----------------------------------------------------------------- stats
  /**
   * Aggregate rounds into per-golfer standings.
   *
   * Deliberately computed rather than stored. Scope is whatever set of rounds
   * you were able to read, so the privacy model and the stats model are the
   * same mechanism (doc 08 §3).
   *
   * `money` is only meaningful within a single settlement scope — a group.
   * Summing it across groups is arithmetic, not a standing: those people never
   * played each other. Callers must not put a cross-group money figure on a
   * leaderboard.
   */
  aggregate(rounds) {
    const by = {};
    for (const r of rounds) {
      const results = r.results || {};
      for (const [golferId, res] of Object.entries(results)) {
        const s = (by[golferId] ||= { golferId, rounds: 0, money: 0, gross: 0, grossRounds: 0, best: null, wins: 0 });
        s.rounds += 1;
        if (typeof res.money === 'number') s.money += res.money;
        if (typeof res.gross === 'number') {
          s.gross += res.gross; s.grossRounds += 1;
          if (s.best == null || res.gross < s.best) s.best = res.gross;
        }
        if (res.money > 0) s.wins += 1;
      }
    }
    return Object.values(by).map((s) => ({
      ...s,
      scoringAvg: s.grossRounds ? +(s.gross / s.grossRounds).toFixed(2) : null,
    })).sort((a, b) => b.money - a.money);
  },
};

export default BB.cloud;
