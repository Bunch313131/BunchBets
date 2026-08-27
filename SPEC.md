# Bunch Bets — Platform Overhaul Spec

> **Status:** Planning / handoff document. Written 2026-08-27.
> **Purpose:** Evolve Bunch Bets from a single-device, localStorage-only PWA into a backend-backed, multi-user platform with GHIN handicaps, persistent round history, and social "groups" (shared pools, stats, money tracking, leaderboards).
> **Audience:** Whoever picks this up next (including future-you across machines via the Claude cowork app).

---

## 1. Vision

Today Bunch Bets is a superb *in-round* betting calculator that lives entirely on one device. The overhaul turns it into a *persistent, social* golf-betting platform:

- **Sign in** → your data follows you across devices.
- **GHIN handicaps** → indexes pulled automatically, Course Handicaps computed per course/tee.
- **Round history** → every round saved to the cloud, browsable, with real stats.
- **Groups** → subscribe to a group; the group has a shared pool of regulars, and tracks scoring averages, money won/lost, and leaderboards across all rounds the group plays.

The GHIN work and the social/database work are **the same project**: GHIN numbers become the canonical identity that links a golfer across rounds, groups, and stats. Doing them together avoids building the identity model twice.

---

## 2. Current architecture (as-is)

**Shape:** One file — `BunchBets/index.html` (~442 KB, ~9,000 lines). HTML + CSS + vanilla JS, no build step. Deployed via GitHub Pages from `main`. Installable PWA.

**Persistence — all localStorage, all device-local:**

| Key | Holds |
|---|---|
| `nassauV28_complete` (`STORAGE_KEY`) | Current live round: games, players, scores, presets |
| `bunchbets_history` (`HISTORY_KEY`) | Last 50 round snapshots (see below) — **already includes money** |
| `bunchbets_roster` | "My Players" pool: `[{name, handicap}]` — device-local, picked from in wizard |
| `bunchbets_theme` / `bunchbets-theme` | Color theme / light-dark |

**Round history snapshot** (`History.archiveCurrent()`, index.html ~1149) already captures per round:
`{ id, date, course, players, games, playerNet, startingHole }` — where `playerNet` is **money won/lost per player**. This is most of a stats backend already; it just isn't durable, queryable, or shared.

**Firebase — already integrated, narrow use:** Realtime Database (`firebase 9.22 compat`). Used **only** for live game sharing: host writes game state to `games/{shareCode}`, guests subscribe (`LiveSync`, index.html ~694–830). Currently pointed at a **test** project (`bunchbets-test`). **No auth, no user accounts, no durable/queryable storage.**

**Handicaps:** Manual. Wizard has a raw `HCP` number per player (index.html ~3501). Course DB stores `par[]` + `hcp[]` per course only — **no Slope, no Rating, no tees**.

**What's missing for the vision:** identity/accounts, durable multi-user data, groups/subscriptions, cross-round aggregation (stats/leaderboards), GHIN.

---

## 3. Target architecture (to-be)

Keep the **offline-first PWA** feel; add a real backend for identity + durable/shared data.

```
┌─────────────────────────────────────────────────────────┐
│  Bunch Bets PWA (GitHub Pages, still single-file-ish)    │
│  • Offline-first: localStorage stays the working cache    │
│  • Live round UX unchanged                                │
└───────────┬───────────────────────────────┬──────────────┘
            │ Auth + durable/social data     │ live round sync
            ▼                                 ▼
   ┌──────────────────┐            ┌────────────────────────┐
   │ Firebase Auth    │            │ Realtime DB (existing) │
   │ Firestore        │            │ ephemeral games/{code} │
   │ (users, groups,  │            └────────────────────────┘
   │  rounds, stats)  │
   └────────┬─────────┘
            │ GHIN lookups (server-side, holds credential)
            ▼
   ┌──────────────────┐         ┌─────────────────┐
   │ Apps Script /    │────────▶│ GHIN API         │
   │ Cloud Function   │         │ (api2.ghin.com)  │
   │ proxy + cache    │         └─────────────────┘
   └──────────────────┘
```

**Backend recommendation: stay in Firebase.** You already run it, know it, and it gives Auth + Firestore + hosting-adjacent tooling with zero new vendors.
- **Firebase Auth** — Google sign-in (you already load Google/gtag). Low friction, no passwords to manage.
- **Firestore** (not Realtime DB) for the new durable/social data — it has the querying/indexing needed for leaderboards, per-golfer aggregation, and group feeds. Realtime DB can't do this cleanly.
- **Keep the existing Realtime DB live-sharing as-is** for now — it's ephemeral, high-frequency, and already works. Migrating live sync into Firestore is optional and later.
- Move off the `bunchbets-test` project to a real prod project before shipping.

**GHIN proxy:** unchanged from the earlier GHIN plan — a server-side proxy (Apps Script mirrors your Pheasant setup, or a Firebase Cloud Function to keep it all in one place) holds one GHIN login, exposes `lookup(ghinNumbers[]) → indexes`, and caches. Required because GHIN needs a login and blocks browser CORS.

---

## 4. Canonical identity — the linchpin

The stats/social features only work if a golfer is the *same entity* across every round and group. Design decision:

- **A golfer's canonical ID = their GHIN number** when they have one; a locally-minted `guest:<uuid>` otherwise (and mergeable into a GHIN id later).
- Round results reference golfers by this canonical ID, not by typed name. Two people who both type "Mike" no longer collide; the same Mike across 30 rounds aggregates correctly.
- A **user account** (Auth uid) is separate from a **golfer** (GHIN id). One account manages many golfers in its groups; a golfer may not have an account at all (they just get scored). Optionally an account can *claim* its own golfer record.

This is why GHIN + social are one project: GHIN numbers are the identity backbone.

---

## 5. Data model (Firestore, first draft)

```
users/{uid}
  displayName, email, createdAt
  groupIds: [groupId, ...]
  myGolferId: ghin:1234567 | null      # the golfer this account "is"

golfers/{golferId}          # golferId = "ghin:1234567" or "guest:<uuid>"
  name
  ghinNumber | null
  currentIndex | null
  indexUpdatedAt | null

groups/{groupId}
  name, ownerUid, createdAt
  inviteCode                            # how people subscribe/join
  memberUids: [uid, ...]
  poolGolferIds: [golferId, ...]        # the group's shared "regulars"

rounds/{roundId}
  groupId | null                        # null = personal round, not group-tracked
  date, courseName, courseSnapshot, startingHole
  golferIds: [golferId, ...]
  games: [ ... ]                        # existing game structures, largely unchanged
  results:                              # canonical per-golfer outcome
    { golferId: { net: <money>, gross: <n>, ... } }
  createdByUid

# Aggregates (denormalized for fast leaderboards; written by a function/trigger
# or recomputed client-side from rounds at first):
groups/{groupId}/stats/{golferId}
  roundsPlayed, moneyNet, scoringAvg, wins, ...  # rolling totals
```

Notes:
- `rounds` is essentially the **existing history snapshot promoted to the cloud**, plus a `groupId` and canonical `golferIds`/`results`. Migration is mostly a reshape of data that already exists locally.
- Aggregates can start as **client-side computation** over a group's rounds (simple, no functions) and graduate to a **Cloud Function trigger** when round counts make that slow.
- **Security rules** matter: a user can read a group's rounds/stats only if their uid is in `memberUids`. Design rules alongside the schema, not after.

---

## 6. Feature breakdown

**6.1 Accounts & sync** — Google sign-in; on login, migrate local `bunchbets_history` + `bunchbets_roster` into the cloud (one-time import). Offline-first: keep writing localStorage as the cache, sync up when online.

**6.2 GHIN handicaps** — (folds in the standalone GHIN plan)
- Roster/pool entries gain `ghinNumber`; "Refresh indexes" batch-calls the proxy.
- Proper **Course Handicap** = `round(Index × Slope/113 + (Rating − Par))`. Requires **Slope/Rating + a tee selector**, which the app lacks today → the main net-new UI/data work. Fallback: if no Slope/Rating, drop raw index into HCP (today's behavior) so nothing breaks.

**6.3 Round history (cloud)** — every completed round → `rounds/{roundId}`. Browse/filter own + group rounds. Reuses the snapshot the app already builds.

**6.4 Groups / subscriptions** — create a group, share an invite code, others subscribe. Group has a **shared pool of regulars** (distinct from personal "My Players"). Rounds tagged to a group feed its stats.

**6.5 Stats & leaderboards** — per group: scoring average, money won/lost, rounds played, wins, best/worst, streaks. Leaderboards sortable by money or scoring. Per-golfer profile view. All keyed off canonical `golferId`.

---

## 7. Phased roadmap (ship incrementally — no big-bang rewrite)

Each phase is independently useful and shippable.

- **Phase 0 — GHIN API probe.** Confirm login + golfer-by-GHIN lookup works against a real account (a single `curl`). *Blocks all GHIN work; cheapest thing to de-risk first.*
- **Phase 1 — Auth + cloud sync of existing local data.** Add Google sign-in + Firestore; migrate `history` and `roster` to the cloud for signed-in users. No new features yet — just durability + cross-device. Establishes the identity model.
- **Phase 2 — GHIN in the roster.** `ghinNumber` field + proxy + "Refresh indexes." Ship raw-index-into-HCP first (no Slope needed).
- **Phase 3 — Proper Course Handicap.** Add Slope/Rating data + tee selector; compute real Course Handicaps. (Heaviest single piece; optional if raw index is "good enough.")
- **Phase 4 — Cloud round history.** Promote round snapshots to `rounds/{roundId}` with canonical `golferIds`. Browse across devices.
- **Phase 5 — Groups.** Create/join groups, shared pool, tag rounds to a group.
- **Phase 6 — Stats & leaderboards.** Aggregate group rounds (client-side first, functions later).

**Rationale for order:** Phase 1 builds the identity/auth spine everything else needs. GHIN (2–3) rides on the roster you already have and delivers visible value fast. History (4) is a data reshape of something that already exists. Groups + stats (5–6) are the payoff, built last on a proven foundation.

---

## 8. Migration & offline strategy

- **Offline-first stays.** localStorage remains the live working cache; the app must fully function with no network (core value prop on the course). Cloud is the sync/durability layer, not a hard dependency.
- **One-time import** on first sign-in: push existing local `history` + `roster` up, keyed to the new account.
- **Conflict policy:** the live round is single-writer on-device; cloud writes happen at round archive time, so conflicts are rare. Last-write-wins on roster edits is acceptable initially.

---

## 9. Open decisions (need answers before/within each phase)

1. **Single-file or modularize?** The app is one 9k-line HTML file (a deliberate, valued trait). A backend + auth + groups will strain that. Recommendation: **stay single-file through Phase 2**, reassess at Phase 4 — a light split (or a build step) may be worth it once Firestore logic grows. Preserving the zero-build GitHub Pages deploy is a real asset.
2. **Firestore vs Realtime DB for durable data.** Recommendation: **Firestore** for social/stats (querying), keep RTDB for live sync. Confirm.
3. **Auth provider.** Recommendation: **Google sign-in** only, at first. Add email/Apple later if needed.
4. **Sync across your own devices for the personal roster** (raised earlier) — becomes automatic once Phase 1 lands. Until then, roster is device-local (current behavior).
5. **GHIN proxy host** — Apps Script (matches Pheasant) vs Firebase Cloud Function (keeps stack unified). Lean Cloud Function if we're in Firebase anyway.
6. **Course Handicap depth** — proper calc (Phase 3, needs Slope/Rating/tees) vs raw index. You chose *proper*; confirm you want to fund the Slope/Rating data entry, or start raw and upgrade.
7. **Prod Firebase project** — stand up a real one; stop shipping against `bunchbets-test`.

---

## 10. Risks

- **GHIN unofficial API** — undocumented, against ToS, can change/break. Keep volume tiny (cached pool). De-risk in Phase 0. *If login is locked down, GHIN features are blocked* — everything else still proceeds.
- **Security rules** — a real multi-user backend means real authz. Group data must be readable only by members. Design rules with the schema.
- **Scope** — this is a months-long evolution. The phased plan keeps every step shippable so it never becomes a stalled big-bang rewrite.
- **Single-file strain** — watch complexity; be willing to introduce structure at Phase 4 rather than forcing everything into one file forever.

---

## 11. Immediate next step

**Run Phase 0** — the GHIN API probe (one `curl` login + lookup against a real GHIN account). It's the only hard blocker and the cheapest thing to verify. Everything else is well-understood, incremental work on foundations that already exist.
