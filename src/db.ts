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

/**
 * How a record is stored. Images are kept as raw bytes (ArrayBuffer), not Blobs:
 * Safari/iOS WebKit often fails to store Blobs in IndexedDB
 * ("Error preparing Blob/File data to be stored in object store").
 * `image` (Blob) is only present on records saved by the first version of the app.
 */
interface Row extends Omit<Txn, 'image'> {
  imageData?: ArrayBuffer | null;
  imageType?: string;
  image?: Blob | null;
}

/** Stored in the browser's IndexedDB, on this device only. */
export const db = new Dexie('gcash-tracker') as Dexie & { txns: EntityTable<Row, 'id'> };

db.version(1).stores({
  txns: '++id, txnDate, refNo, type',
});

async function toRow<T extends { image: Blob | null }>(t: T) {
  const { image, ...rest } = t;
  return {
    ...rest,
    image: undefined,
    imageData: image ? await image.arrayBuffer() : null,
    imageType: image?.type || 'image/jpeg',
  };
}

function fromRow(r: Row): Txn {
  const { imageData, imageType, image, ...rest } = r;
  return {
    ...rest,
    image: imageData ? new Blob([imageData], { type: imageType || 'image/jpeg' }) : (image ?? null),
  };
}

/** All transactions, newest first, optionally filtered by a search string. */
export async function listTxns(search = ''): Promise<Txn[]> {
  const all = (await db.txns.orderBy('txnDate').reverse().toArray()).map(fromRow);
  const q = search.trim().toLowerCase();
  if (!q) return all;
  return all.filter((t) =>
    [t.recipient, t.refNo, t.note, t.type, t.phone].some((v) => (v ?? '').toLowerCase().includes(q)),
  );
}

export async function findByRefNo(refNo: string, excludeId?: number) {
  if (!refNo) return undefined;
  const rows = await db.txns.where('refNo').equals(refNo).toArray();
  const r = rows.find((x) => x.id !== excludeId);
  return r ? fromRow(r) : undefined;
}

export async function getTxn(id: number) {
  const r = await db.txns.get(id);
  return r ? fromRow(r) : undefined;
}

export async function addTxn(t: TxnInput, createdAt = new Date().toISOString()) {
  await requestPersistence();
  return db.txns.add({ ...(await toRow(t)), createdAt } as Row);
}

export async function updateTxn(id: number, t: TxnInput) {
  await db.txns.update(id, await toRow(t));
}

export const deleteTxn = (id: number) => db.txns.delete(id);

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
