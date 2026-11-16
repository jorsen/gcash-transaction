import Dexie, { type EntityTable } from 'dexie';
import type { TxnType } from './parseGcash';

export interface Txn {
  id: number;
  type: TxnType;
  amount: number;
  refNo: string;
  recipient: string;
  phone: string;
  /** "YYYY-MM-DD HH:mm" local time */
  txnDate: string;
  note: string;
  /** Compressed receipt image (JPEG), or null if none. */
  image: Blob | null;
  rawText: string;
  createdAt: string;
}

export type TxnInput = Omit<Txn, 'id' | 'createdAt'>;

/** Stored in the browser's IndexedDB, on this device only. */
export const db = new Dexie('gcash-tracker') as Dexie & { txns: EntityTable<Txn, 'id'> };

db.version(1).stores({
  txns: '++id, txnDate, refNo, type',
});

export async function listTxns(search: string): Promise<Txn[]> {
  const all = await db.txns.orderBy('txnDate').reverse().toArray();
  const q = search.trim().toLowerCase();
  if (!q) return all;
  return all.filter((t) =>
    [t.recipient, t.refNo, t.note, t.type, t.phone].some((v) => v.toLowerCase().includes(q)),
  );
}

export async function findByRefNo(refNo: string, excludeId?: number) {
  if (!refNo) return undefined;
  const rows = await db.txns.where('refNo').equals(refNo).toArray();
  return rows.find((r) => r.id !== excludeId);
}

export async function addTxn(t: TxnInput) {
  await requestPersistence();
  return db.txns.add({ ...t, createdAt: new Date().toISOString() } as Txn);
}

export const updateTxn = (id: number, t: TxnInput) => db.txns.update(id, t);
export const deleteTxn = (id: number) => db.txns.delete(id);
export const getTxn = (id: number) => db.txns.get(id);

/** Ask the browser not to evict our data when the device is low on space. */
async function requestPersistence() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) {
      await navigator.storage.persist();
    }
  } catch {
    // Not supported; data is still stored, just "best effort".
  }
}
