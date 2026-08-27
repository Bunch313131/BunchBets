# Backend — Firestore rules and their tests

Not deployed with the app. This directory holds the security rules and the
emulator test suite that proves them.

## Why the tests exist

These rules **are** the privacy model — stats scoping, group visibility and who
can see whom are enforced here, not in the client. The suite is written around
the DENY cases, because a rule only ever exercised on the happy path is a rule
nobody has tested.

It has already earned its keep: the first run caught that a group-mate could
*seize* an unclaimed golfer record, because "Mike claims his own record" and
"Mike takes Dave's record" are byte-identical writes at the rules layer.

## Running it

```bash
cd backend
npm install
firebase emulators:start --only firestore --project bb-test   # needs a JVM
FIRESTORE_EMULATOR_HOST=127.0.0.1:8181 node --test rules.test.js
```

51 cases, all passing as of 2026-08-27.

## Deploying the rules

```bash
firebase deploy --only firestore:rules --project <bunchbets-test|bunchbets>
```

Never deploy rules that have not been run against this suite.
