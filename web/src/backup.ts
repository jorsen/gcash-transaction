import { db, type Txn } from './db';

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const today = () => new Date().toISOString().slice(0, 10);

const csvCell = (v: string | number) => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Spreadsheet-friendly export (opens in Excel / Google Sheets). Images are not included. */
export async function exportCsv() {
  const rows = await db.txns.orderBy('txnDate').toArray();
  const header = ['Date', 'Type', 'Amount', 'Reference No.', 'Name / Merchant', 'Mobile', 'Note'];
  const lines = [
    header.join(','),
    ...rows.map((t) =>
      [t.txnDate, t.type, t.amount.toFixed(2), `'${t.refNo}`, t.recipient, t.phone, t.note]
        .map(csvCell)
        .join(','),
    ),
  ];
  // BOM so Excel reads the ₱ sign and names correctly.
  download(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv' }), `gcash-transactions-${today()}.csv`);
}

const blobToDataUrl = (b: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(b);
  });

type BackupRow = Omit<Txn, 'id' | 'image'> & { image: string | null };

/** Full backup including receipt images, to restore on this or another phone. */
export async function exportBackup() {
  const rows = await db.txns.toArray();
  const out: BackupRow[] = [];
  for (const { id: _id, image, ...rest } of rows) {
    out.push({ ...rest, image: image ? await blobToDataUrl(image) : null });
  }
  const json = JSON.stringify({ app: 'gcash-tracker', version: 1, exportedAt: new Date().toISOString(), txns: out });
  download(new Blob([json], { type: 'application/json' }), `gcash-backup-${today()}.json`);
}

/** Restores a backup. Records already present (same ref no., date and amount) are skipped. */
export async function importBackup(file: File): Promise<{ added: number; skipped: number }> {
  const data = JSON.parse(await file.text());
  if (data?.app !== 'gcash-tracker' || !Array.isArray(data.txns)) {
    throw new Error('This is not a GCash Tracker backup file.');
  }
  const existing = await db.txns.toArray();
  const key = (t: { refNo: string; txnDate: string; amount: number }) => `${t.refNo}|${t.txnDate}|${t.amount}`;
  const seen = new Set(existing.map(key));
  let added = 0;
  let skipped = 0;
  for (const row of data.txns as BackupRow[]) {
    if (seen.has(key(row))) {
      skipped++;
      continue;
    }
    const image = row.image ? await (await fetch(row.image)).blob() : null;
    await db.txns.add({ ...row, image } as Txn);
    seen.add(key(row));
    added++;
  }
  return { added, skipped };
}
