import { neon } from '@neondatabase/serverless';
import { normalizeMaskedName } from '../src/parseGcash.js';

export type QueryFn = <T = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<T[]>;

declare global {
  // Lets local dev/tests plug in an embedded Postgres (PGlite) instead of Neon.
  var __gcashQuery: QueryFn | undefined;
}

let neonQuery: QueryFn | null = null;

function getQuery(): QueryFn {
  if (globalThis.__gcashQuery) return globalThis.__gcashQuery;
  if (!neonQuery) {
    // DATABASE_URL is the default name; STORAGE_URL is what Vercel's Neon integration uses with its default prefix.
    const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? process.env.STORAGE_URL;
    if (!url) throw new Error('DATABASE_URL is not set. Connect a Postgres database (Neon) to the Vercel project.');
    const sql = neon(url);
    neonQuery = (text, params = []) => sql.query(text, params) as never;
  }
  return neonQuery;
}

let schemaReady: Promise<void> | null = null;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('owner', 'tindera')),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS transactions (
    id SERIAL PRIMARY KEY,
    type TEXT NOT NULL,
    amount NUMERIC(12, 2) NOT NULL,
    ref_no TEXT NOT NULL DEFAULT '',
    recipient TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    txn_date TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    raw_text TEXT NOT NULL DEFAULT '',
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS transactions_txn_date_idx ON transactions (txn_date)`,
  `CREATE INDEX IF NOT EXISTS transactions_ref_no_idx ON transactions (ref_no)`,
  `CREATE INDEX IF NOT EXISTS transactions_created_by_idx ON transactions (created_by)`,
  `CREATE TABLE IF NOT EXISTS receipt_images (
    txn_id INTEGER PRIMARY KEY REFERENCES transactions(id) ON DELETE CASCADE,
    mime TEXT NOT NULL,
    data BYTEA NOT NULL
  )`,
  // v2: multi-business. Super admin -> businesses -> owners + tinderas; every transaction belongs to a business.
  // Runs as one statement (one transaction) under an advisory lock, so concurrent cold starts can't race.
  // Existing single-business data is moved into a first business automatically.
  `DO $$
  DECLARE
    biz INTEGER;
    owner_name TEXT;
  BEGIN
    PERFORM pg_advisory_xact_lock(727274);
    CREATE TABLE IF NOT EXISTS businesses (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS business_id INTEGER REFERENCES businesses(id);
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS business_id INTEGER REFERENCES businesses(id);
    CREATE INDEX IF NOT EXISTS users_business_idx ON users (business_id);
    CREATE INDEX IF NOT EXISTS transactions_business_idx ON transactions (business_id, txn_date);
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
    ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('superadmin', 'owner', 'tindera'));
    IF EXISTS (SELECT 1 FROM users WHERE business_id IS NULL AND role <> 'superadmin') THEN
      SELECT name INTO owner_name FROM users WHERE business_id IS NULL AND role = 'owner' ORDER BY id LIMIT 1;
      INSERT INTO businesses (name) VALUES (COALESCE(owner_name || '''s Business', 'My Business')) RETURNING id INTO biz;
      UPDATE users SET business_id = biz WHERE business_id IS NULL AND role <> 'superadmin';
    END IF;
    UPDATE transactions t SET business_id = u.business_id
      FROM users u WHERE t.created_by = u.id AND t.business_id IS NULL;
  END $$`,
  // v3: push notifications + cash-in requests.
  `CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx ON push_subscriptions (user_id)`,
  `CREATE TABLE IF NOT EXISTS cashin_requests (
    id SERIAL PRIMARY KEY,
    business_id INTEGER NOT NULL REFERENCES businesses(id),
    created_by INTEGER NOT NULL REFERENCES users(id),
    number TEXT NOT NULL,
    gcash_name TEXT NOT NULL,
    amount NUMERIC(12, 2),
    note TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'cancelled')),
    handled_by INTEGER REFERENCES users(id),
    handled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS cashin_requests_business_idx ON cashin_requests (business_id, status, created_at)`,
  // v4: cash-out requests, and the GCash receipt attached when the owner completes a request.
  `ALTER TABLE cashin_requests ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'cashin'`,
  `ALTER TABLE cashin_requests ADD COLUMN IF NOT EXISTS txn_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL`,
  // v5: "processing" step (owner copied the number and is sending it in GCash).
  // One statement under an advisory lock so concurrent cold starts can't race on the constraint.
  `DO $$
  BEGIN
    PERFORM pg_advisory_xact_lock(727275);
    ALTER TABLE cashin_requests ADD COLUMN IF NOT EXISTS processing_at TIMESTAMPTZ;
    ALTER TABLE cashin_requests ADD COLUMN IF NOT EXISTS processing_by INTEGER REFERENCES users(id);
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conname = 'cashin_requests_status_check' AND pg_get_constraintdef(oid) LIKE '%processing%'
    ) THEN
      ALTER TABLE cashin_requests DROP CONSTRAINT IF EXISTS cashin_requests_status_check;
      ALTER TABLE cashin_requests ADD CONSTRAINT cashin_requests_status_check
        CHECK (status IN ('pending', 'processing', 'done', 'cancelled'));
    END IF;
  END $$`,
  // v6: tindera reminders ("Pa cash in po!" again) while the owner hasn't responded.
  `ALTER TABLE cashin_requests ADD COLUMN IF NOT EXISTS remind_count INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE cashin_requests ADD COLUMN IF NOT EXISTS last_reminded_at TIMESTAMPTZ`,
  // v7: activity log (who did what, when) per business.
  `CREATE TABLE IF NOT EXISTS activity_log (
    id BIGSERIAL PRIMARY KEY,
    business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    user_name TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT '',
    action TEXT NOT NULL,
    summary TEXT NOT NULL,
    target_type TEXT,
    target_id INTEGER,
    device TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS activity_log_business_idx ON activity_log (business_id, id DESC)`,
  // v8: cash-out from other banks (InstaPay / PESONet) + proof photo of the customer's receipt.
  `ALTER TABLE cashin_requests ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'gcash'`,
  `ALTER TABLE cashin_requests ADD COLUMN IF NOT EXISTS bank_name TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE cashin_requests ADD COLUMN IF NOT EXISTS account_last4 TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE cashin_requests ADD COLUMN IF NOT EXISTS ref_no TEXT NOT NULL DEFAULT ''`,
  `CREATE TABLE IF NOT EXISTS request_proofs (
    request_id INTEGER PRIMARY KEY REFERENCES cashin_requests(id) ON DELETE CASCADE,
    mime TEXT NOT NULL,
    data BYTEA NOT NULL
  )`,
  // v9: deleted staff. Kept (their past receipts/requests still show their name) but hidden and unable to log in.
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`,
  // v10: "Send Money" receipts are the store's cash-ins (owner sends GCash to the customer).
  `UPDATE transactions SET type = 'Cash In' WHERE type = 'Send Money'`,
];

/** Creates tables on first use (idempotent), so there is no separate migration step. */
/**
 * One-time data fix: names saved before the masked-name cleanup have OCR junk where GCash shows
 * dots ("AleeeN C." -> "AL•••N C."). Runs once per database; safe to repeat (idempotent).
 */
async function fixMaskedNamesOnce(q: QueryFn) {
  const done = await q(`SELECT 1 FROM app_settings WHERE key = 'fix_masked_names_v1'`);
  if (done.length) return;
  const txns = await q<{ id: number; recipient: string }>(`SELECT id, recipient FROM transactions WHERE recipient <> ''`);
  for (const t of txns) {
    const fixed = normalizeMaskedName(t.recipient);
    if (fixed !== t.recipient) await q(`UPDATE transactions SET recipient = $1 WHERE id = $2`, [fixed, t.id]);
  }
  const reqs = await q<{ id: number; gcash_name: string }>(`SELECT id, gcash_name FROM cashin_requests`);
  for (const r of reqs) {
    const fixed = normalizeMaskedName(r.gcash_name).toUpperCase(); // GCash names are all capitals
    if (fixed !== r.gcash_name) await q(`UPDATE cashin_requests SET gcash_name = $1 WHERE id = $2`, [fixed, r.id]);
  }
  await q(`INSERT INTO app_settings (key, value) VALUES ('fix_masked_names_v1', NOW()::text) ON CONFLICT (key) DO NOTHING`);
}

function ensureSchema() {
  schemaReady ??= (async () => {
    const q = getQuery();
    for (const stmt of SCHEMA) await q(stmt);
    await fixMaskedNamesOnce(q);
  })().catch((e) => {
    schemaReady = null;
    throw e;
  });
  return schemaReady;
}

export async function query<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  await ensureSchema();
  return getQuery()<T>(text, params);
}
