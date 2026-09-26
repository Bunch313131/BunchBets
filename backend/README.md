# Backend — Firestore rules, cloud module, and their tests

Not part of the app bundle. The cloud module (`cloud.js`) ships to `js/cloud.js`;
everything else here is tooling.

| File | What |
|---|---|
| `firestore.rules` | Security rules. **These are the privacy model** — stats scoping, group visibility and who can see whom are enforced here, not in the client. |
| `firestore.indexes.json` | Composite indexes the client queries need. |
| `rules.test.js` | 86 rules tests against the emulator, weighted toward DENY cases. |
| `cloud.js` | Auth + Firestore module. Reaches the app through `window.BB`. |
| `cloud.test.mjs` | 9 integration tests: the real module, in a real browser, against real rules. Needs a real roster CSV. |
| `groups.test.mjs` | 14 integration tests for groups — create, share link, join, add/remove golfers, leave, emailed invites. Seeds its own data; needs no roster and no GHIN. |
| `seed.js` | Roster CSV → golfers, group, invitations. Validates every GHIN first. |

## Why there are two test suites

`rules.test.js` asserts the rules against queries written by hand — my
assumptions about how the client will ask. `cloud.test.mjs` asserts them against
the queries the client actually makes. The gap between those is where the bugs
live: three real defects came out of it, and none were visible in review.

## Running

```bash
npm install                                # firebase-admin and playwright
firebase emulators:start --only firestore,auth --project bb-test   # needs a JVM

# rules
FIRESTORE_EMULATOR_HOST=127.0.0.1:8181 node --test rules.test.js

# integration — needs cloud-test.html served from the REPO ROOT (not backend/),
#   because the page loads ./js/cloud.js and ./vendor/ relative to it.
#   cloud.test.mjs wipes and reseeds Firestore itself.
cd .. && python3 -m http.server 8099 &
node --test cloud.test.mjs                 # from backend/
node --test groups.test.mjs                # from backend/
```

## Groups

The group made by `seed.js` (no `kind` field) is the **directory**: everyone
this set of people plays with. Playing groups are made in the app
(`kind: 'group'`) from golfers already in the directory, and joined with a
share link (`?group=<id>&code=<joinCode>`). A golfer can be in any number of
groups via `poolGroupIds`. The directory's owner makes its share link from the
app (Groups → the directory → Invite people).

The rules changes that came with groups also close three holes that existed
before them, so deploy them to beta as well as prod:
- `users.groupIds` could be written freely, and `sharesPool` trusted it, so
  anyone who knew a group id could read its golfers.
- Anyone could append themselves to any group's `memberUids`.
- Any member could rewrite `ownerUid`.

`vendor/` holds local copies of the compat SDK, because the page must not
depend on reaching a CDN mid-test. It is gitignored. Where gstatic is not
reachable, `backend/node_modules/firebase/firebase-*-compat.js` are the same
builds and can be copied in. Otherwise rebuild it from the repo root with:

```bash
mkdir -p vendor && for f in firebase-app-compat.js firebase-auth-compat.js \
    firebase-firestore-compat.js firebase-database-compat.js; do
  curl -sS -o vendor/$f https://www.gstatic.com/firebasejs/9.22.0/$f
done
```

Both emulator ports are pinned in `firebase.json` (firestore 8181, auth 9099).
On a host without IPv6 the emulator warns that it cannot bind `::1` and binds
`127.0.0.1` only — harmless, and the suite addresses it by IP anyway.

## Seeding

```bash
node seed.js --csv roster.csv --group "Name" --owner-uid <uid> \
             --ghin-creds ../ghin-creds.rtf            # dry run
node seed.js ... --commit                              # writes
node seed.js ... --service-account key.json --commit   # against a real project
```

Dry run by default. Every GHIN is checked against the API and rows whose name
does not match are refused — on the first real roster that caught a number
belonging to a different golfer entirely.

## Deploying rules

```bash
firebase deploy --only firestore:rules,firestore:indexes --project <project>
```

**Never deploy rules that have not been run against both suites**, and add a
test for every new clause — written to fail first.
