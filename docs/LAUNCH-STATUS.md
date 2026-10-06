# Production accounts launch — status (2026-10-06)

## Done
- **Daily GHIN refresh** (`.github/workflows/refresh-indexes.yml`): 5:17am Pacific, updates both
  `bunchbets-test` and `bunchbets`. Secrets: `GHIN_CREDS`, `FIREBASE_KEY_TEST`, `FIREBASE_KEY_PROD`.
- **`bunchbets` (prod) Firebase project**
  - Auth: Google + Email/Password (email link) enabled; authorized domains include bunchbets.com, www.bunchbets.com.
  - Firestore rules match repo `backend/firestore.rules`.
  - 4 composite indexes built — `node backend/check-prod.mjs <prod-key>.json` reports `ready`.
  - Browser API key (Jan 30 key, `AIzaSyDZlb…`): website restrictions now include bunchbets.com,
    www.bunchbets.com, bunchbets.firebaseapp.com, bunchbets.web.app; Identity Toolkit, Token Service,
    Cloud Firestore APIs allowed. Verified from bunchbets.com and the auth handler referer.
  - No stale beta claims (only Brian's invite accepted).
- **main**: v7.17 `?cloud=1` opt-in, v7.18 five-tap opt-in on the menu's Offline line (production only).

## Open
1. **Google sign-in in the installed iPhone app on bunchbets.com returns to "Sign in"** even after the
   API key fix. Next: read the "Sign-in diagnostics" box (menu → Account) after a failed attempt.
2. **main is 18 commits behind `staging`** (beta = v7.31; prod = main at v7.18). Beta has the redesigned
   wizard (v7.17 on staging), email/password sign-in (v7.26), shared groups (v7.25), admin page, etc.
   - Version numbers collide: main's 7.17/7.18 (opt-in commits) ≠ staging's 7.17/7.18.
   - The sign-in problem may already be solved on staging; the realistic launch is **staging → main**,
     carrying the opt-in (or flipping `CLOUD_ENABLED` to true) on top, with a version above 7.31.
   - Check how staging deploys to the beta (Cloudflare Pages `bunchbets-beta.pages.dev`) and whether
     staging reads newer Firestore collections (e.g. courses in DB, directory) that prod lacks.
3. Before launch: re-run `copy-project.mjs` (test → prod) for rounds since Sep 14, and re-run
   `check-prod.mjs`; staging's newer collections may need copying/indexes too.
4. Small: `check-prod.mjs` prints "rerun with --fix" for indexes still BUILDING, and prints the
   "build in the background" line even when every create failed.
