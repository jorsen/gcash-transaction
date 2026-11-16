# GCash Tracker

A web app (installable on Android and iPhone) for a store that handles GCash transactions.
Tinderas capture or upload GCash receipts. The app reads the details, they check them and save,
and the **owner sees every transaction from any device**.

## Features

- **Accounts:** one **owner** plus **tindera** accounts (username + password) that the owner creates.
  - **Owner:** sees all transactions, filters by tindera, edits and deletes, manages staff (add, reset password,
    deactivate), and exports to Excel (CSV).
  - **Tindera:** records transactions, and sees and edits only her own. She can't delete.
- **Capture Receipt / From Gallery**, then **text recognition in the browser** (Tesseract.js) fills in the
  amount, reference number, date and time, type, name, and mobile number. Every field can be edited before saving.
- **Duplicate warning** when a reference number was already recorded by anyone in the store.
- **Monthly summary** (money out and money in) with previous/next month, plus search.
- **Cloud storage in PostgreSQL**: transactions and compressed receipt images (~150 KB each).
- Records saved on a phone by the earlier offline-only version can be uploaded with one tap.

## How it fits together

| Path | Purpose |
| --- | --- |
| `api/index.ts` | The single Vercel Function; `vercel.json` routes all `/api/*` requests to it |
| `server/router.ts` | API routes: session, setup, login, staff, transactions, images |
| `server/auth.ts` | Password hashing (scrypt) and login sessions (HttpOnly cookie, hashed tokens in the DB) |
| `server/db.ts` | PostgreSQL access (Neon driver) and automatic table creation |
| `src/` | The web app (React): `App.tsx`, `Review.tsx`, `Staff.tsx`, `Login.tsx`, OCR, and the receipt parser |
| `dev/apiDevPlugin.ts` | Local development only: runs the API inside `npm run dev` with an embedded Postgres |

Tables (created automatically on first request): `users`, `sessions`, `transactions`, `receipt_images`.

## Deploy on Vercel

1. **Database:** Vercel project → **Storage** → **Create Database** → **Neon (Serverless Postgres)** → free plan → connect it
   to this project for all environments. This adds `DATABASE_URL`.
2. **Setup code:** Vercel project → **Settings → Environment Variables** → add `SETUP_CODE` with a secret
   phrase of your choice. It's needed once, to create the owner account.
3. **Deploy:** push to `main` (or click **Redeploy**), so the deployment picks up both variables.
4. Open the site. The first screen asks for the setup code, then creates the **owner** account.
5. Owner: ⋮ menu → **Staff accounts** → add each tindera with a username and password.

## Develop

```bash
npm install
npm run dev     # http://localhost:5173. API with an embedded Postgres in ./.pglite; setup code: dev-setup
npm run build   # type-check + build
```

Set `DATABASE_URL` before `npm run dev` to use a real Postgres instead.
The camera, installing, and offline mode need HTTPS, so test those on the deployed site.
