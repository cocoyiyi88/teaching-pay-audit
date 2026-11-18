# Deployment

## Vercel

Import the GitHub repository and configure:

```text
Framework Preset: Other
Build Command: npm run build
Output Directory: dist
```

Set environment variables:

```text
VITE_FIREBASE_API_KEY
VITE_FIREBASE_PROJECT_ID
```

Redeploy after changing environment variables.

## Post-deployment validation

1. Open the Production URL in a clean browser.
2. Create an account with a test name.
3. Record hours and confirm salary calculation.
4. Open a second browser and sign in with the same account.
5. Confirm data appears and updates automatically.
6. Create a second account and confirm no data from the first account appears.
7. Download monthly and annual PDFs.
8. Test JSON backup/restore.
9. Test safe sign-out.

## Firestore rules rollout for per-entry synchronization

The web client stores the rate revision inside the first day record to preserve
compatibility with the existing rules. Validate the expanded rules with Firestore
Emulator before publishing those rules separately. Older clients write whole-month
snapshots, so have users close existing tabs and reopen the app after rollout to
limit mixed-version editing.

Deploy the SuperApp endpoint first. The owner creates a MySalary sync key on the
SuperApp dashboard and enters it in MySalary Settings on each browser used for
immediate sync. After a successful cloud commit, the browser only sends that
scoped key. The Worker has permission to refresh the connected dashboard only.
Verify the dashboard timestamp after a save. The existing Cron remains a fallback.
