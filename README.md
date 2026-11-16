# GCash Tracker

A web app (installable on Android and iPhone) for stores that handle GCash transactions.
Tinderas capture or upload GCash receipts. The app reads the details, they check them and save,
the **owner sees every transaction from any device**, and a **super admin** manages all the businesses.

## Features

- **Accounts (multi-business):**
  - **Super admin:** creates businesses (each with an owner), adds more owners or tinderas to any business,
    resets passwords, deactivates staff or a whole business, and views any business's transactions.
  - **Owner:** sees all of their business's transactions, filters by tindera, edits and deletes, manages their
    tinderas, and exports to Excel (CSV).
  - **Tindera:** records transactions for her business, and sees and edits only her own. She can't delete.
  - Businesses are fully separated: nobody sees another business's data.
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

Tables (created and migrated automatically on first request): `businesses`, `users`, `sessions`, `transactions`, `receipt_images`.

## Deploy on Vercel

1. **Database:** Vercel project → **Storage** → **Create Database** → **Neon (Serverless Postgres)** → free plan → connect it
   to this project for all environments. This adds `DATABASE_URL`.
2. **Setup code:** Vercel project → **Settings → Environment Variables** → add `SETUP_CODE` with a secret
   phrase of your choice. It is needed once, to create the super admin account.
3. **Deploy:** push to `main` (or click **Redeploy**), so the deployment picks up both variables.
4. Open the site → **First-time setup (super admin)** → enter the setup code and create the **super admin** account.
5. Super admin: **＋ Add business** for each store (with its owner's login). Owners then add tinderas from ⋮ → **Staff accounts**.

## Develop

```bash
npm install
npm run dev     # http://localhost:5173. API with an embedded Postgres in ./.pglite; setup code: dev-setup
npm run build   # type-check + build
```

Set `DATABASE_URL` before `npm run dev` to use a real Postgres instead.
The camera, installing, and offline mode need HTTPS, so test those on the deployed site.
