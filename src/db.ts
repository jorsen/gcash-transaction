import Dexie, { type EntityTable } from 'dexie';
import type { TxnType } from './parseGcash';

/**
 * Records saved on this device by the earlier offline-only version of the app.
 * They are only read so they can be uploaded to the cloud, then cleared.
 */
export interface LocalTxn {
  id: number;
  type: TxnType;
  amount: number;
  refNo: string;
  recipient: string;
  phone: string;
  txnDate: string;
  note: string;
  image: Blob | null;
  rawText: string;
}

interface Row extends Omit<LocalTxn, 'image'> {
  imageData?: ArrayBuffer | null;
  imageType?: string;
  image?: Blob | null;
}

const db = new Dexie('gcash-tracker') as Dexie & { txns: EntityTable<Row, 'id'> };
db.version(1).stores({ txns: '++id, txnDate, refNo, type' });

export async function countLocal(): Promise<number> {
  try {
    return await db.txns.count();
  } catch {
    return 0;
  }
}

export async function listLocal(): Promise<LocalTxn[]> {
  const rows = await db.txns.orderBy('txnDate').toArray();
  return rows.map(({ imageData, imageType, image, ...rest }) => ({
    ...rest,
    image: imageData ? new Blob([imageData], { type: imageType || 'image/jpeg' }) : (image ?? null),
  }));
}

export const deleteLocal = (id: number) => db.txns.delete(id);
