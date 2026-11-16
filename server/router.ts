import { TXN_TYPES } from '../src/parseGcash.js';
import {
  createSession,
  currentUser,
  destroySession,
  endSessionsForUser,
  hashPassword,
  verifyPassword,
  type User,
} from './auth.js';
import { query } from './db.js';

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const json = (data: unknown, init: ResponseInit = {}) =>
  Response.json(data, { ...init, headers: { 'Cache-Control': 'no-store', ...init.headers } });

async function body<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, 'Invalid request body.');
  }
}

function requireUser(user: User | null): User {
  if (!user) throw new HttpError(401, 'Please log in.');
  return user;
}

function requireOwner(user: User | null): User {
  const u = requireUser(user);
  if (u.role !== 'owner') throw new HttpError(403, 'Only the owner can do this.');
  return u;
}

const USERNAME = /^[a-z0-9._-]{3,30}$/;

function cleanUsername(v: unknown) {
  const u = String(v ?? '').trim().toLowerCase();
  if (!USERNAME.test(u)) throw new HttpError(400, 'Username must be 3–30 characters: letters, numbers, dot, dash or underscore.');
  return u;
}

function cleanPassword(v: unknown) {
  const p = String(v ?? '');
  if (p.length < 6) throw new HttpError(400, 'Password must be at least 6 characters.');
  if (p.length > 200) throw new HttpError(400, 'Password is too long.');
  return p;
}

function cleanName(v: unknown) {
  const n = String(v ?? '').trim();
  if (!n || n.length > 60) throw new HttpError(400, 'Please enter a name (up to 60 characters).');
  return n;
}

// ---------- transactions ----------

interface TxnBody {
  type: string;
  amount: number | string;
  refNo?: string;
  recipient?: string;
  phone?: string;
  txnDate: string;
  note?: string;
  rawText?: string;
  /** New image as base64; null removes the image; omitted keeps the current one. */
  image?: { mime: string; base64: string } | null;
}

const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

function cleanTxn(b: TxnBody) {
  const amount = Number(String(b.amount).replace(/,/g, ''));
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10_000_000) throw new HttpError(400, 'Please enter a valid amount.');
  if (!TXN_TYPES.includes(b.type as never)) throw new HttpError(400, 'Invalid transaction type.');
  const txnDate = String(b.txnDate ?? '').replace('T', ' ').slice(0, 16);
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(txnDate)) throw new HttpError(400, 'Please enter the date and time.');
  const s = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);
  return {
    type: b.type,
    amount: Math.round(amount * 100) / 100,
    refNo: s(b.refNo, 40).replace(/\s+/g, ''),
    recipient: s(b.recipient, 120),
    phone: s(b.phone, 30),
    txnDate,
    note: s(b.note, 1000),
    rawText: s(b.rawText, 20000),
  };
}

function cleanImage(img: TxnBody['image']) {
  if (!img) return null;
  if (!/^image\/(jpeg|png|webp)$/.test(img.mime)) throw new HttpError(400, 'Unsupported image type.');
  if (img.base64.length > (MAX_IMAGE_BYTES * 4) / 3) throw new HttpError(413, 'Image is too large.');
  return img;
}

const TXN_COLUMNS = `t.id, t.type, t.amount::float8 AS amount, t.ref_no AS "refNo", t.recipient, t.phone,
  t.txn_date AS "txnDate", t.note, t.created_by AS "createdBy", u.name AS "createdByName",
  t.updated_at AS "updatedAt", (i.txn_id IS NOT NULL) AS "hasImage"`;
const TXN_FROM = `FROM transactions t JOIN users u ON u.id = t.created_by LEFT JOIN receipt_images i ON i.txn_id = t.id`;

async function loadTxn(id: number, user: User) {
  const rows = await query<Record<string, unknown> & { createdBy: number }>(
    `SELECT ${TXN_COLUMNS}, t.raw_text AS "rawText" ${TXN_FROM} WHERE t.id = $1`,
    [id],
  );
  const t = rows[0];
  if (!t) throw new HttpError(404, 'Transaction not found.');
  if (user.role !== 'owner' && t.createdBy !== user.id) throw new HttpError(403, 'You can only open your own transactions.');
  return t;
}

async function saveImage(txnId: number, img: { mime: string; base64: string } | null | undefined) {
  if (img === undefined) return; // keep
  if (img === null) {
    await query(`DELETE FROM receipt_images WHERE txn_id = $1`, [txnId]);
    return;
  }
  await query(
    `INSERT INTO receipt_images (txn_id, mime, data) VALUES ($1, $2, decode($3, 'base64'))
     ON CONFLICT (txn_id) DO UPDATE SET mime = EXCLUDED.mime, data = EXCLUDED.data`,
    [txnId, img.mime, img.base64],
  );
}

// ---------- router ----------

export async function handle(req: Request): Promise<Response> {
  try {
    return await route(req);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, { status: e.status });
    console.error(e);
    return json({ error: 'Server error. Please try again.' }, { status: 500 });
  }
}

async function route(req: Request): Promise<Response> {
  const url = new URL(req.url);
  // Vercel rewrites /api/* to the single /api function; the original path is kept,
  // with ?route= as a fallback.
  const path = (url.pathname.replace(/^\/api\/?/, '') || url.searchParams.get('route') || '').replace(/\/+$/, '');
  const parts = path.split('/').filter(Boolean);
  const m = req.method;
  const user = await currentUser(req);

  // --- session / setup ---
  if (path === 'session' && m === 'GET') {
    const [{ count }] = await query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM users`);
    return json({ user, needsSetup: count === 0 });
  }

  if (path === 'setup' && m === 'POST') {
    const b = await body<{ setupCode: string; name: string; username: string; password: string }>(req);
    const code = process.env.SETUP_CODE;
    if (!code) throw new HttpError(400, 'SETUP_CODE is not set on the server. Add it in Vercel → Settings → Environment Variables, then redeploy.');
    if (b.setupCode !== code) throw new HttpError(403, 'Wrong setup code.');
    const [{ count }] = await query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM users`);
    if (count > 0) throw new HttpError(409, 'The owner account already exists. Please log in.');
    const [u] = await query<User>(
      `INSERT INTO users (username, name, password_hash, role) VALUES ($1, $2, $3, 'owner')
       RETURNING id, username, name, role`,
      [cleanUsername(b.username), cleanName(b.name), await hashPassword(cleanPassword(b.password))],
    );
    return json({ user: u }, { headers: { 'Set-Cookie': await createSession(req, u.id) } });
  }

  if (path === 'login' && m === 'POST') {
    const b = await body<{ username: string; password: string }>(req);
    const rows = await query<User & { password_hash: string; active: boolean }>(
      `SELECT id, username, name, role, password_hash, active FROM users WHERE username = $1`,
      [String(b.username ?? '').trim().toLowerCase()],
    );
    const u = rows[0];
    const ok = u ? await verifyPassword(String(b.password ?? ''), u.password_hash) : false;
    if (!u || !ok) throw new HttpError(401, 'Wrong username or password.');
    if (!u.active) throw new HttpError(403, 'This account is deactivated. Please ask the owner.');
    const out: User = { id: u.id, username: u.username, name: u.name, role: u.role };
    return json({ user: out }, { headers: { 'Set-Cookie': await createSession(req, u.id) } });
  }

  if (path === 'logout' && m === 'POST') {
    return json({ ok: true }, { headers: { 'Set-Cookie': await destroySession(req) } });
  }

  if (path === 'password' && m === 'POST') {
    const me = requireUser(user);
    const b = await body<{ current: string; next: string }>(req);
    const [row] = await query<{ password_hash: string }>(`SELECT password_hash FROM users WHERE id = $1`, [me.id]);
    if (!(await verifyPassword(String(b.current ?? ''), row.password_hash))) throw new HttpError(400, 'Current password is wrong.');
    await query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [await hashPassword(cleanPassword(b.next)), me.id]);
    return json({ ok: true });
  }

  // --- staff (owner only) ---
  if (path === 'users' && m === 'GET') {
    requireOwner(user);
    const users = await query(
      `SELECT u.id, u.username, u.name, u.role, u.active, u.created_at AS "createdAt",
              COUNT(t.id)::int AS "txnCount"
         FROM users u LEFT JOIN transactions t ON t.created_by = u.id
        GROUP BY u.id ORDER BY u.role DESC, u.name`,
    );
    return json({ users });
  }

  if (path === 'users' && m === 'POST') {
    requireOwner(user);
    const b = await body<{ name: string; username: string; password: string }>(req);
    const username = cleanUsername(b.username);
    const exists = await query(`SELECT 1 FROM users WHERE username = $1`, [username]);
    if (exists.length) throw new HttpError(409, `Username "${username}" is already taken.`);
    const [u] = await query(
      `INSERT INTO users (username, name, password_hash, role) VALUES ($1, $2, $3, 'tindera')
       RETURNING id, username, name, role, active`,
      [username, cleanName(b.name), await hashPassword(cleanPassword(b.password))],
    );
    return json({ user: u });
  }

  if (parts[0] === 'users' && parts.length === 2 && m === 'PATCH') {
    const owner = requireOwner(user);
    const id = Number(parts[1]);
    const b = await body<{ name?: string; password?: string; active?: boolean }>(req);
    const [target] = await query<{ role: Role }>(`SELECT role FROM users WHERE id = $1`, [id]);
    if (!target) throw new HttpError(404, 'User not found.');
    if (b.name !== undefined) await query(`UPDATE users SET name = $1 WHERE id = $2`, [cleanName(b.name), id]);
    if (b.password !== undefined) {
      await query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [await hashPassword(cleanPassword(b.password)), id]);
      if (id !== owner.id) await endSessionsForUser(id); // log the tindera out everywhere
    }
    if (b.active !== undefined) {
      if (target.role === 'owner') throw new HttpError(400, 'The owner account cannot be deactivated.');
      await query(`UPDATE users SET active = $1 WHERE id = $2`, [Boolean(b.active), id]);
      if (!b.active) await endSessionsForUser(id);
    }
    return json({ ok: true });
  }

  // --- transactions ---
  if (path === 'transactions' && m === 'GET') {
    const me = requireUser(user);
    const month = url.searchParams.get('month') ?? ''; // "YYYY-MM" or "" for all
    const search = (url.searchParams.get('search') ?? '').trim();
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (me.role !== 'owner') add('t.created_by = ?', me.id);
    else if (url.searchParams.get('userId')) add('t.created_by = ?', Number(url.searchParams.get('userId')));
    if (/^\d{4}-\d{2}$/.test(month) && !search) add('substr(t.txn_date, 1, 7) = ?', month);
    if (search) {
      params.push(`%${search}%`);
      const p = `$${params.length}`;
      where.push(`(t.recipient ILIKE ${p} OR t.ref_no ILIKE ${p} OR t.note ILIKE ${p} OR t.type ILIKE ${p} OR t.phone ILIKE ${p} OR u.name ILIKE ${p})`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const items = await query(
      `SELECT ${TXN_COLUMNS} ${TXN_FROM} ${whereSql} ORDER BY t.txn_date DESC, t.id DESC LIMIT 1000`,
      params,
    );
    const [summary] = await query(
      `SELECT COUNT(*)::int AS count,
              COALESCE(SUM(CASE WHEN t.type IN ('Received', 'Cash In') THEN 0 ELSE t.amount END), 0)::float8 AS outflow,
              COALESCE(SUM(CASE WHEN t.type IN ('Received', 'Cash In') THEN t.amount ELSE 0 END), 0)::float8 AS inflow
         FROM transactions t JOIN users u ON u.id = t.created_by ${whereSql}`,
      params,
    );
    return json({ items, summary });
  }

  if (path === 'transactions' && m === 'POST') {
    const me = requireUser(user);
    const b = await body<TxnBody>(req);
    const t = cleanTxn(b);
    const img = cleanImage(b.image);
    const [row] = await query<{ id: number }>(
      `INSERT INTO transactions (type, amount, ref_no, recipient, phone, txn_date, note, raw_text, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [t.type, t.amount, t.refNo, t.recipient, t.phone, t.txnDate, t.note, t.rawText, me.id],
    );
    await saveImage(row.id, img);
    return json({ id: row.id });
  }

  if (path === 'check-ref' && m === 'GET') {
    requireUser(user);
    const ref = (url.searchParams.get('ref') ?? '').replace(/\s+/g, '');
    const exclude = Number(url.searchParams.get('excludeId') ?? 0);
    if (!ref) return json({ duplicate: null });
    const rows = await query(
      `SELECT t.id, t.ref_no AS "refNo", t.txn_date AS "txnDate", t.recipient, t.type, u.name AS "createdByName"
         FROM transactions t JOIN users u ON u.id = t.created_by
        WHERE t.ref_no = $1 AND t.id <> $2 LIMIT 1`,
      [ref, exclude],
    );
    return json({ duplicate: rows[0] ?? null });
  }

  if (parts[0] === 'transactions' && parts.length >= 2) {
    const me = requireUser(user);
    const id = Number(parts[1]);
    if (!Number.isInteger(id)) throw new HttpError(404, 'Not found.');

    if (parts[2] === 'image' && m === 'GET') {
      await loadTxn(id, me); // permission check
      const [img] = await query<{ mime: string; base64: string }>(
        `SELECT mime, encode(data, 'base64') AS base64 FROM receipt_images WHERE txn_id = $1`,
        [id],
      );
      if (!img) throw new HttpError(404, 'No image.');
      return new Response(Buffer.from(img.base64.replace(/\s+/g, ''), 'base64'), {
        headers: { 'Content-Type': img.mime, 'Cache-Control': 'private, max-age=31536000, immutable' },
      });
    }

    if (parts.length === 2 && m === 'GET') return json({ txn: await loadTxn(id, me) });

    if (parts.length === 2 && m === 'PUT') {
      await loadTxn(id, me);
      const b = await body<TxnBody>(req);
      const t = cleanTxn(b);
      await query(
        `UPDATE transactions SET type = $1, amount = $2, ref_no = $3, recipient = $4, phone = $5,
           txn_date = $6, note = $7, raw_text = $8, updated_at = NOW() WHERE id = $9`,
        [t.type, t.amount, t.refNo, t.recipient, t.phone, t.txnDate, t.note, t.rawText, id],
      );
      await saveImage(id, b.image === undefined ? undefined : cleanImage(b.image));
      return json({ ok: true });
    }

    if (parts.length === 2 && m === 'DELETE') {
      requireOwner(me);
      await query(`DELETE FROM transactions WHERE id = $1`, [id]);
      return json({ ok: true });
    }
  }

  throw new HttpError(404, 'Not found.');
}

type Role = User['role'];
