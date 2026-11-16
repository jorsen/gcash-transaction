# GCash Tracker

Records GCash transactions from receipts. Capture a receipt with the camera or pick a
screenshot from the gallery. The app reads the receipt on-device and fills in the amount,
reference number, date and time, recipient, and mobile number. You review the details,
then save them to a local database.

## Features

- **Capture Receipt**: take a photo of a GCash receipt.
- **From Gallery**: import a GCash receipt screenshot from your albums.
- **On-device OCR** (`expo-text-extractor`: ML Kit on Android, Apple Vision on iOS). Works offline, and nothing is uploaded.
- **Review before saving**: every field is editable. Re-scan, retake, or choose another image.
- **Duplicate warning** when a reference number is already recorded.
- **Monthly summary** of money out and money in, plus search by name, reference number, note, or type.
- The receipt image is copied into app storage, so the record keeps it even if you delete the screenshot.

## Project layout

| Path | Purpose |
| --- | --- |
| `src/app/index.tsx` | Home: summary, capture/gallery buttons, transaction list |
| `src/app/review.tsx` | Review, edit, or delete a transaction |
| `src/lib/parseGcash.ts` | Turns OCR text into fields (amount, ref no., date, type, recipient) |
| `src/lib/db.ts` | SQLite schema, migrations, queries |
| `src/lib/ocr.ts` | On-device text recognition |
| `src/lib/pickReceipt.ts` | Camera/gallery permissions and pickers |
| `src/lib/images.ts` | Copies receipt images into app storage |

## Running it

OCR uses native code, so you need a **development build**. In **Expo Go** the app runs,
but you fill in the fields by hand.

### Option A: build in the cloud with EAS (no Android Studio needed)

```bash
npm install
npx eas-cli@latest login
npx eas-cli@latest build --profile development --platform android
```

Install the APK from the link EAS gives you. Then start the dev server:

```bash
npx expo start
```

Open the installed app and scan the QR code.

To get a standalone APK you can share, without the dev server, use `--profile preview`.

### Option B: build locally

Install Android Studio (with JDK and Android SDK) or Xcode, then run:

```bash
npx expo run:android   # or: npx expo run:ios
```

## Checks

```bash
npx tsc --noEmit
npx expo lint
npx expo-doctor
```

---

# Web app (installable PWA): `web/`

The same app as a website you can **install to the home screen** on Android and iPhone.
No APK and no app store needed.

- **Capture / From Gallery** use the browser's camera and photo picker.
- **OCR runs in the browser** (Tesseract.js). The first scan downloads the English text model
  (a few MB, cached afterwards). Receipt images never leave the device.
- **Data stays on the phone** in the browser's IndexedDB. Images are shrunk to about 150 KB each.
- **Menu (⋮):** export to Excel (CSV), back up everything including images (JSON), and restore a backup
  on this or another phone.
- Reuses the native app's receipt parser (`src/lib/parseGcash.ts`).

```bash
cd web
npm install
npm run dev       # http://localhost:5173 (also reachable from a phone on the same Wi-Fi)
npm run build     # static site in web/dist
```

The camera, installing, and offline mode need **HTTPS**, so test those on the deployed site.

## Deploy (Vercel, free)

1. Go to vercel.com → **Add New → Project** → import `jorsen/gcash-transaction` from GitHub.
2. Set **Root Directory** to `web` (Vercel detects Vite automatically).
3. Click **Deploy**. Every push to `main` redeploys automatically.
