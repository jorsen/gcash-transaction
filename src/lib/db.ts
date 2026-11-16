import type { SQLiteDatabase } from 'expo-sqlite';
import type { TxnType } from './parseGcash';

export interface Transaction {
  id: number;
  type: TxnType;
  amount: number;
  ref_no: string;
  recipient: string;
  phone: string;
  /** "YYYY-MM-DD HH:mm" local time */
  txn_date: string;
  note: string;
  image_uri: string;
  raw_text: string;
  created_at: string;
}

export type TransactionInput = Omit<Transaction, 'id' | 'created_at'>;

export const DATABASE_NAME = 'gcash.db';

export async function migrateDbIfNeeded(db: SQLiteDatabase) {
  const DATABASE_VERSION = 1;
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  const currentVersion = row?.user_version ?? 0;
  if (currentVersion >= DATABASE_VERSION) return;

  if (currentVersion === 0) {
    await db.execAsync(`
      PRAGMA journal_mode = 'wal';
      CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY NOT NULL,
        type TEXT NOT NULL,
        amount REAL NOT NULL,
        ref_no TEXT NOT NULL DEFAULT '',
        recipient TEXT NOT NULL DEFAULT '',
        phone TEXT NOT NULL DEFAULT '',
        txn_date TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        image_uri TEXT NOT NULL DEFAULT '',
        raw_text TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_txn_date ON transactions (txn_date);
      CREATE INDEX IF NOT EXISTS idx_ref_no ON transactions (ref_no);
    `);
  }
  await db.execAsync(`PRAGMA user_version = ${DATABASE_VERSION}`);
}

export function listTransactions(db: SQLiteDatabase, search = '') {
  const q = `%${search.trim()}%`;
  return db.getAllAsync<Transaction>(
    `SELECT * FROM transactions
     WHERE ? = '%%' OR recipient LIKE ? OR ref_no LIKE ? OR note LIKE ? OR type LIKE ?
     ORDER BY txn_date DESC, id DESC`,
    q, q, q, q, q,
  );
}

export function getTransaction(db: SQLiteDatabase, id: number) {
  return db.getFirstAsync<Transaction>('SELECT * FROM transactions WHERE id = ?', id);
}

/** Returns another transaction that already uses this reference number, if any. */
export function findByRefNo(db: SQLiteDatabase, refNo: string, excludeId?: number) {
  if (!refNo) return Promise.resolve(null);
  return db.getFirstAsync<Transaction>(
    'SELECT * FROM transactions WHERE ref_no = ? AND id != ?',
    refNo,
    excludeId ?? -1,
  );
}

export async function insertTransaction(db: SQLiteDatabase, t: TransactionInput) {
  const r = await db.runAsync(
    `INSERT INTO transactions (type, amount, ref_no, recipient, phone, txn_date, note, image_uri, raw_text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    t.type, t.amount, t.ref_no, t.recipient, t.phone, t.txn_date, t.note, t.image_uri, t.raw_text,
  );
  return r.lastInsertRowId;
}

export async function updateTransaction(db: SQLiteDatabase, id: number, t: TransactionInput) {
  await db.runAsync(
    `UPDATE transactions SET type = ?, amount = ?, ref_no = ?, recipient = ?, phone = ?,
       txn_date = ?, note = ?, image_uri = ?, raw_text = ? WHERE id = ?`,
    t.type, t.amount, t.ref_no, t.recipient, t.phone, t.txn_date, t.note, t.image_uri, t.raw_text, id,
  );
}

export async function deleteTransaction(db: SQLiteDatabase, id: number) {
  await db.runAsync('DELETE FROM transactions WHERE id = ?', id);
}

export interface Summary {
  count: number;
  outflow: number;
  inflow: number;
}

/** Totals for a "YYYY-MM" month. Received / Cash In count as money in; everything else as money out. */
export async function monthSummary(db: SQLiteDatabase, yearMonth: string): Promise<Summary> {
  const row = await db.getFirstAsync<Summary>(
    `SELECT COUNT(*) AS count,
       COALESCE(SUM(CASE WHEN type IN ('Received', 'Cash In') THEN 0 ELSE amount END), 0) AS outflow,
       COALESCE(SUM(CASE WHEN type IN ('Received', 'Cash In') THEN amount ELSE 0 END), 0) AS inflow
     FROM transactions WHERE substr(txn_date, 1, 7) = ?`,
    yearMonth,
  );
  return row ?? { count: 0, outflow: 0, inflow: 0 };
}
