# GCash Tracker

A web app you can **install to your home screen** (PWA) on Android and iPhone.
It records GCash transactions from receipts: capture a receipt with the camera or pick a
screenshot from your gallery. The app reads the details, you check them, and it saves the transaction.

## Features

- **Capture Receipt / From Gallery** using the phone's camera or photo picker.
- **Text recognition in the browser** (Tesseract.js) fills in the amount, reference number,
  date and time, type, name, and mobile number. Every field can be edited before saving.
- **Duplicate warning** when a reference number is already saved.
- **Monthly summary** of money out and money in, plus search by name, reference number, note, or type.
- **Data stays on the phone** in the browser's IndexedDB. Receipt images are shrunk to about 150 KB each
  and never uploaded.
- **Menu (⋮):** Export to Excel (CSV), Back up (including images), and Restore (also onto a new phone).
- **Works offline** after the first scan. The first scan downloads the English text model (a few MB),
  which is then cached.

## Project layout

| Path | Purpose |
| --- | --- |
| `src/App.tsx` | Home: install banner, summary, capture/gallery buttons, list, menu |
| `src/Review.tsx` | Review, edit, or delete a transaction |
| `src/parseGcash.ts` | Turns OCR text into fields (amount, ref no., date, type, recipient) |
| `src/ocr.ts` | Text recognition (Tesseract.js worker) |
| `src/image.ts` | Image orientation fix and compression |
| `src/db.ts` | IndexedDB storage (Dexie) |
| `src/backup.ts` | CSV export and JSON backup/restore |
| `vite.config.ts` | Build and PWA (manifest, service worker, offline caching) |

## Develop

```bash
npm install
npm run dev       # http://localhost:5173 (also reachable from a phone on the same Wi-Fi)
npm run build     # type-check and build the static site into dist/
npm run icons     # regenerate app icons from public/icon.png
```

The camera, installing, and offline mode need **HTTPS**, so test those on the deployed site.

## Deploy (Vercel, free)

1. Go to vercel.com → **Add New → Project** → import `jorsen/gcash-transaction` from GitHub.
2. Keep the defaults (Vercel detects Vite; output folder `dist`). Click **Deploy**.
3. Every push to `main` redeploys automatically.

Open the site on your phone and tap **Install app**. On iPhone, use Safari's **Share → Add to Home Screen**.
