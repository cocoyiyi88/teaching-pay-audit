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

Validate rules with Firestore Emulator before deploying. Exercise legacy month documents
and documents containing entry timestamps and an optional rate timestamp. Publish rules
before publishing the web build because the previous rules reject the new rate field.
Keep the expanded rules when rolling back the web build so the older client can still
write. Older clients write whole-month snapshots, so have users close existing tabs and
reopen the app after rollout to limit mixed-version editing.

Browser writes no longer send Firebase ID tokens to the SuperApp. Verify that the
SuperApp scheduler imports a saved change before relying on refreshed dashboard data.
