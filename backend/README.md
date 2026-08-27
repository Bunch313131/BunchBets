# Backend — Firestore rules, cloud module, and their tests

Not part of the app bundle. The cloud module (`cloud.js`) ships to `js/cloud.js`;
everything else here is tooling.

| File | What |
|---|---|
| `firestore.rules` | Security rules. **These are the privacy model** — stats scoping, group visibility and who can see whom are enforced here, not in the client. |
| `firestore.indexes.json` | Composite indexes the client queries need. |
| `rules.test.js` | 51 rules tests against the emulator, weighted toward DENY cases. |
| `cloud.js` | Auth + Firestore module. Reaches the app through `window.BB`. |
| `cloud.test.mjs` | 9 integration tests: the real module, in a real browser, against real rules. |
| `seed.js` | Roster CSV → golfers, group, invitations. Validates every GHIN first. |

## Why there are two test suites

`rules.test.js` asserts the rules against queries written by hand — my
assumptions about how the client will ask. `cloud.test.mjs` asserts them against
the queries the client actually makes. The gap between those is where the bugs
live: three real defects came out of it, and none were visible in review.

## Running

```bash
npm install
firebase emulators:start --only firestore,auth --project bb-test   # needs a JVM

# rules
FIRESTORE_EMULATOR_HOST=127.0.0.1:8181 node --test rules.test.js

# integration — also needs the harness served and the emulator seeded
#   (cloud.test.mjs wipes and reseeds Firestore itself)
cd ../apptest && python3 -m http.server 8099 &
node --test cloud.test.mjs
```

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
