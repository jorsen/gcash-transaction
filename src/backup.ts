import { api, blobToPayload, type Txn } from './api';
import { deleteLocal, listLocal } from './db';

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

const csvCell = (v: string | number) => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Spreadsheet-friendly export (opens in Excel / Google Sheets) of the given transactions. */
export function exportCsv(items: Txn[], label: string) {
  const header = ['Date', 'Type', 'Amount', 'Reference No.', 'Name / Merchant', 'Mobile', 'Note', 'Recorded by'];
  const rows = [...items].sort((a, b) => a.txnDate.localeCompare(b.txnDate));
  const lines = [
    header.join(','),
    ...rows.map((t) =>
      [t.txnDate, t.type, t.amount.toFixed(2), `'${t.refNo}`, t.recipient, t.phone, t.note, t.createdByName]
        .map(csvCell)
        .join(','),
    ),
  ];
  // BOM so Excel reads the ₱ sign and names correctly.
  download(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv' }), `gcash-transactions-${label}.csv`);
}

/**
 * Uploads records saved on this device by the old offline version to the cloud,
 * removing each one locally once it is safely stored.
 */
export async function uploadLocalRecords(onProgress: (done: number, total: number) => void) {
  const rows = await listLocal();
  let done = 0;
  for (const r of rows) {
    await api.addTransaction({
      type: r.type,
      amount: r.amount,
      refNo: r.refNo,
      recipient: r.recipient,
      phone: r.phone,
      txnDate: r.txnDate,
      note: r.note,
      rawText: r.rawText,
      image: r.image ? await blobToPayload(r.image) : null,
    });
    await deleteLocal(r.id);
    onProgress(++done, rows.length);
  }
  return done;
}
