import { normalizeMaskedName, TXN_TYPES } from '../src/parseGcash.js';
import {
  createSession,
  currentUser,
  destroySession,
  endSessionsForUser,
  hashPassword,
  USER_COLUMNS,
  verifyPassword,
  type Role,
  type User,
} from './auth.js';
import { query } from './db.js';
import { notifyOwners, notifyUsers, publicKey, removeSubscription, saveSubscription } from './push.js';

const peso = (n: number) => `₱${n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** "09171234567" -> "0917 123 4567" */
const prettyNumber = (n: string) => n.replace(/^(\d{4})(\d{3})(\d{4})$/, '$1 $2 $3');

/*
 * Roles
 *  - superadmin: manages businesses and their owners/tinderas; can view any business.
 *  - owner:      manages one business: its tinderas and all of its transactions.
 *  - tindera:    records transactions for her business; sees/edits only her own.
 * Every transaction query is scoped to one business.
 */

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

const isManager = (u: User) => u.role === 'owner' || u.role === 'superadmin';

function requireManager(user: User | null): User {
  const u = requireUser(user);
  if (!isManager(u)) throw new HttpError(403, 'Only the owner can do this.');
  return u;
}

function requireSuperadmin(user: User | null): User {
  const u = requireUser(user);
  if (u.role !== 'superadmin') throw new HttpError(403, 'Only the super admin can do this.');
  return u;
}

/** The business this request acts on. The super admin must say which one; everyone else uses their own. */
function businessScope(me: User, requested: unknown): number {
  if (me.role !== 'superadmin') return me.businessId as number;
  const id = Number(requested);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Choose a business first.');
  return id;
}

/** Accepts 09XX…, +63 9XX…, 63 9XX…, 9XX… with any spacing; returns "09XXXXXXXXX". */
function cleanMobile(v: unknown) {
  let d = String(v ?? '').replace(/\D/g, '');
  if (d.startsWith('63') && d.length === 12) d = '0' + d.slice(2);
  if (d.startsWith('9') && d.length === 10) d = '0' + d;
  if (!/^09\d{9}$/.test(d)) throw new HttpError(400, 'Enter an 11-digit mobile number, e.g. 0917 123 4567.');
  return d;
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

function cleanName(v: unknown, what = 'a name') {
  const n = String(v ?? '').trim();
  if (!n || n.length > 80) throw new HttpError(400, `Please enter ${what} (up to 80 characters).`);
  return n;
}

async function assertUsernameFree(username: string) {
  const exists = await query(`SELECT 1 FROM users WHERE username = $1`, [username]);
  if (exists.length) throw new HttpError(409, `Username "${username}" is already taken.`);
}

async function assertBusinessExists(id: number) {
  const rows = await query(`SELECT 1 FROM businesses WHERE id = $1`, [id]);
  if (!rows.length) throw new HttpError(404, 'Business not found.');
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
  /** Super admin only: which business to record into. */
  businessId?: number;
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
    recipient: normalizeMaskedName(s(b.recipient, 120)),
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
  t.business_id AS "businessId", t.updated_at AS "updatedAt", (i.txn_id IS NOT NULL) AS "hasImage"`;
const TXN_FROM = `FROM transactions t JOIN users u ON u.id = t.created_by LEFT JOIN receipt_images i ON i.txn_id = t.id`;

/** Loads a transaction the user is allowed to see, or throws 404/403. */
async function loadTxn(id: number, me: User) {
  const rows = await query<Record<string, unknown> & { createdBy: number; businessId: number }>(
    `SELECT ${TXN_COLUMNS}, t.raw_text AS "rawText" ${TXN_FROM} WHERE t.id = $1`,
    [id],
  );
  const t = rows[0];
  if (!t) throw new HttpError(404, 'Transaction not found.');
  if (me.role !== 'superadmin') {
    // Other businesses' records look like they don't exist.
    if (t.businessId !== me.businessId) throw new HttpError(404, 'Transaction not found.');
    if (me.role === 'tindera' && t.createdBy !== me.id) throw new HttpError(403, 'You can only open your own transactions.');
  }
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

  // ---------- session / setup ----------
  if (path === 'session' && m === 'GET') {
    const [r] = await query<{ superadmins: number }>(
      `SELECT COUNT(*) FILTER (WHERE role = 'superadmin')::int AS superadmins FROM users`,
    );
    return json({ user, needsSetup: r.superadmins === 0 });
  }

  if (path === 'setup' && m === 'POST') {
    const b = await body<{ setupCode: string; name: string; username: string; password: string }>(req);
    const code = process.env.SETUP_CODE;
    if (!code) throw new HttpError(400, 'SETUP_CODE is not set on the server. Add it in Vercel → Settings → Environment Variables, then redeploy.');
    if (b.setupCode !== code) throw new HttpError(403, 'Wrong setup code.');
    const [r] = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM users WHERE role = 'superadmin'`);
    if (r.n > 0) throw new HttpError(409, 'The super admin account already exists. Please log in.');
    const username = cleanUsername(b.username);
    await assertUsernameFree(username);
    const [u] = await query<{ id: number }>(
      `INSERT INTO users (username, name, password_hash, role) VALUES ($1, $2, $3, 'superadmin') RETURNING id`,
      [username, cleanName(b.name), await hashPassword(cleanPassword(b.password))],
    );
    const me: User = { id: u.id, username, name: cleanName(b.name), role: 'superadmin', businessId: null, businessName: null };
    return json({ user: me }, { headers: { 'Set-Cookie': await createSession(req, u.id) } });
  }

  if (path === 'login' && m === 'POST') {
    const b = await body<{ username: string; password: string }>(req);
    const rows = await query<User & { passwordHash: string; active: boolean; businessActive: boolean | null }>(
      `SELECT ${USER_COLUMNS}, u.password_hash AS "passwordHash", u.active, b.active AS "businessActive"
         FROM users u LEFT JOIN businesses b ON b.id = u.business_id WHERE u.username = $1`,
      [String(b.username ?? '').trim().toLowerCase()],
    );
    const u = rows[0];
    const ok = u ? await verifyPassword(String(b.password ?? ''), u.passwordHash) : false;
    if (!u || !ok) throw new HttpError(401, 'Wrong username or password.');
    if (!u.active) throw new HttpError(403, 'This account is deactivated. Please ask your owner or admin.');
    if (u.role !== 'superadmin' && !u.businessActive) throw new HttpError(403, 'This business is deactivated. Please contact the admin.');
    const me: User = { id: u.id, username: u.username, name: u.name, role: u.role, businessId: u.businessId, businessName: u.businessName };
    return json({ user: me }, { headers: { 'Set-Cookie': await createSession(req, u.id) } });
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

  // ---------- businesses (super admin) ----------
  if (path === 'businesses' && m === 'GET') {
    requireSuperadmin(user);
    const businesses = await query(
      `SELECT bz.id, bz.name, bz.active, bz.created_at AS "createdAt",
              COALESCE((SELECT string_agg(o.name, ', ' ORDER BY o.id) FROM users o
                         WHERE o.business_id = bz.id AND o.role = 'owner'), '') AS "owners",
              (SELECT COUNT(*)::int FROM users s WHERE s.business_id = bz.id AND s.role = 'tindera') AS "tinderaCount",
              (SELECT COUNT(*)::int FROM transactions t WHERE t.business_id = bz.id) AS "txnCount"
         FROM businesses bz ORDER BY bz.active DESC, bz.name`,
    );
    return json({ businesses });
  }

  if (path === 'businesses' && m === 'POST') {
    requireSuperadmin(user);
    const b = await body<{ name: string; ownerName: string; ownerUsername: string; ownerPassword: string }>(req);
    const name = cleanName(b.name, 'the business name');
    const ownerName = cleanName(b.ownerName, "the owner's name");
    const username = cleanUsername(b.ownerUsername);
    const password = cleanPassword(b.ownerPassword);
    await assertUsernameFree(username);
    const [bz] = await query<{ id: number }>(`INSERT INTO businesses (name) VALUES ($1) RETURNING id`, [name]);
    await query(
      `INSERT INTO users (username, name, password_hash, role, business_id) VALUES ($1, $2, $3, 'owner', $4)`,
      [username, ownerName, await hashPassword(password), bz.id],
    );
    return json({ business: { id: bz.id, name } });
  }

  if (parts[0] === 'businesses' && parts.length === 2 && m === 'PATCH') {
    requireSuperadmin(user);
    const id = Number(parts[1]);
    await assertBusinessExists(id);
    const b = await body<{ name?: string; active?: boolean }>(req);
    if (b.name !== undefined) await query(`UPDATE businesses SET name = $1 WHERE id = $2`, [cleanName(b.name, 'the business name'), id]);
    if (b.active !== undefined) {
      await query(`UPDATE businesses SET active = $1 WHERE id = $2`, [Boolean(b.active), id]);
      if (!b.active) await query(`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE business_id = $1)`, [id]);
    }
    return json({ ok: true });
  }

  // ---------- staff (owner: own business; super admin: any business) ----------
  if (path === 'users' && m === 'GET') {
    const me = requireManager(user);
    const businessId = businessScope(me, url.searchParams.get('businessId'));
    const users = await query(
      `SELECT u.id, u.username, u.name, u.role, u.active, u.created_at AS "createdAt",
              COUNT(t.id)::int AS "txnCount"
         FROM users u LEFT JOIN transactions t ON t.created_by = u.id
        WHERE u.business_id = $1
        GROUP BY u.id ORDER BY (u.role = 'owner') DESC, u.name`,
      [businessId],
    );
    return json({ users });
  }

  if (path === 'users' && m === 'POST') {
    const me = requireManager(user);
    const b = await body<{ name: string; username: string; password: string; role?: Role; businessId?: number }>(req);
    const businessId = businessScope(me, b.businessId);
    const role: Role = b.role ?? 'tindera';
    if (role === 'superadmin') throw new HttpError(400, 'Invalid role.');
    if (role === 'owner' && me.role !== 'superadmin') throw new HttpError(403, 'Only the super admin can add owners.');
    await assertBusinessExists(businessId);
    const username = cleanUsername(b.username);
    await assertUsernameFree(username);
    const [u] = await query(
      `INSERT INTO users (username, name, password_hash, role, business_id) VALUES ($1, $2, $3, $4, $5)
       RETURNING id, username, name, role, active`,
      [username, cleanName(b.name), await hashPassword(cleanPassword(b.password)), role, businessId],
    );
    return json({ user: u });
  }

  if (parts[0] === 'users' && parts.length === 2 && m === 'PATCH') {
    const me = requireManager(user);
    const id = Number(parts[1]);
    const [target] = await query<{ role: Role; businessId: number | null }>(
      `SELECT role, business_id AS "businessId" FROM users WHERE id = $1`,
      [id],
    );
    if (!target) throw new HttpError(404, 'User not found.');
    const self = id === me.id;
    if (me.role === 'owner') {
      if (target.businessId !== me.businessId) throw new HttpError(404, 'User not found.');
      if (target.role !== 'tindera' && !self) throw new HttpError(403, 'Only the super admin can change other owners.');
    } else if (target.role === 'superadmin' && !self) {
      throw new HttpError(403, 'Not allowed.');
    }
    const b = await body<{ name?: string; password?: string; active?: boolean }>(req);
    if (b.name !== undefined) await query(`UPDATE users SET name = $1 WHERE id = $2`, [cleanName(b.name), id]);
    if (b.password !== undefined) {
      await query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [await hashPassword(cleanPassword(b.password)), id]);
      if (!self) await endSessionsForUser(id); // log them out everywhere
    }
    if (b.active !== undefined) {
      if (self) throw new HttpError(400, "You can't deactivate your own account.");
      if (target.role === 'owner' && me.role !== 'superadmin') throw new HttpError(403, 'Only the super admin can deactivate owners.');
      await query(`UPDATE users SET active = $1 WHERE id = $2`, [Boolean(b.active), id]);
      if (!b.active) await endSessionsForUser(id);
    }
    return json({ ok: true });
  }

  // ---------- transactions ----------
  if (path === 'transactions' && m === 'GET') {
    const me = requireUser(user);
    const businessId = businessScope(me, url.searchParams.get('businessId'));
    const month = url.searchParams.get('month') ?? ''; // "YYYY-MM" or "" for all
    const search = (url.searchParams.get('search') ?? '').trim();
    const params: unknown[] = [businessId];
    const where: string[] = ['t.business_id = $1'];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (me.role === 'tindera') add('t.created_by = ?', me.id);
    else if (url.searchParams.get('userId')) add('t.created_by = ?', Number(url.searchParams.get('userId')));
    if (/^\d{4}-\d{2}$/.test(month) && !search) add('substr(t.txn_date, 1, 7) = ?', month);
    if (search) {
      params.push(`%${search}%`);
      const p = `$${params.length}`;
      where.push(`(t.recipient ILIKE ${p} OR t.ref_no ILIKE ${p} OR t.note ILIKE ${p} OR t.type ILIKE ${p} OR t.phone ILIKE ${p} OR u.name ILIKE ${p})`);
    }
    const whereSql = `WHERE ${where.join(' AND ')}`;
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
    const businessId = businessScope(me, b.businessId);
    const t = cleanTxn(b);
    const img = cleanImage(b.image);
    const [row] = await query<{ id: number }>(
      `INSERT INTO transactions (type, amount, ref_no, recipient, phone, txn_date, note, raw_text, created_by, business_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [t.type, t.amount, t.refNo, t.recipient, t.phone, t.txnDate, t.note, t.rawText, me.id, businessId],
    );
    await saveImage(row.id, img);
    await notifyOwners(
      businessId,
      me.id,
      {
        title: `New receipt from ${me.name}`,
        body: `${t.type} ${peso(t.amount)}${t.recipient ? ` · ${t.recipient}` : ''}${t.refNo ? ` · Ref ${t.refNo}` : ''}`,
        url: `/?txn=${row.id}`,
        tag: `txn-${row.id}`,
      },
      url.origin,
    );
    return json({ id: row.id });
  }

  // ---------- push notifications ----------
  if (path === 'push/key' && m === 'GET') {
    requireUser(user);
    return json({ publicKey: await publicKey() });
  }

  if (path === 'push/subscribe' && m === 'POST') {
    const me = requireUser(user);
    const b = await body<{ endpoint?: string; keys?: { p256dh?: string; auth?: string } }>(req);
    if (!b.endpoint?.startsWith('https://') || !b.keys?.p256dh || !b.keys?.auth) throw new HttpError(400, 'Invalid subscription.');
    await saveSubscription(me.id, { endpoint: b.endpoint, keys: { p256dh: b.keys.p256dh, auth: b.keys.auth } });
    return json({ ok: true });
  }

  if (path === 'push/unsubscribe' && m === 'POST') {
    const me = requireUser(user);
    const b = await body<{ endpoint?: string }>(req);
    if (b.endpoint) await removeSubscription(me.id, b.endpoint);
    return json({ ok: true });
  }

  if (path === 'push/test' && m === 'POST') {
    const me = requireUser(user);
    await notifyUsers(
      [me.id],
      { title: 'Notifications are on ✓', body: 'You will be notified about new receipts and cash-in requests.', url: '/', tag: 'test' },
      url.origin,
    );
    return json({ ok: true });
  }

  // ---------- cash-in requests ----------
  // Tindera: customer's mobile number + GCash name (asterisks allowed, as GCash shows it) + amount.
  // Owner: copies the number, sends the money in GCash, then marks it done.
  if (path === 'cashin' && m === 'GET') {
    const me = requireUser(user);
    const businessId = businessScope(me, url.searchParams.get('businessId'));
    const params: unknown[] = [businessId];
    let where = 'c.business_id = $1';
    if (me.role === 'tindera') {
      params.push(me.id);
      where += ` AND c.created_by = $${params.length}`;
    }
    const [{ pending }] = await query<{ pending: number }>(
      `SELECT COUNT(*)::int AS pending FROM cashin_requests c WHERE ${where} AND c.status = 'pending'`,
      params,
    );
    if (url.searchParams.get('status') === 'pending') where += ` AND c.status = 'pending'`;
    const items = await query(
      `SELECT c.id, c.number, c.gcash_name AS "gcashName", c.amount::float8 AS amount, c.note, c.status,
              c.created_at AS "createdAt", c.handled_at AS "handledAt", c.created_by AS "createdBy",
              cu.name AS "createdByName", hu.name AS "handledByName"
         FROM cashin_requests c JOIN users cu ON cu.id = c.created_by LEFT JOIN users hu ON hu.id = c.handled_by
        WHERE ${where}
        ORDER BY (c.status = 'pending') DESC, c.created_at DESC LIMIT 200`,
      params,
    );
    return json({ items, pending });
  }

  if (path === 'cashin' && m === 'POST') {
    const me = requireUser(user);
    const b = await body<{ number: string; gcashName: string; amount?: number | string | null; note?: string; businessId?: number }>(req);
    const businessId = businessScope(me, b.businessId);
    const number = cleanMobile(b.number);
    // Typed asterisks / OCR junk become GCash-style dots: "JU** DE*A C." -> "JU•• DE•A C."
    const gcashName = normalizeMaskedName(String(b.gcashName ?? '')).toUpperCase();
    if (!gcashName || gcashName.length > 80) throw new HttpError(400, 'Enter the GCash name (asterisks are OK, e.g. JU** DE* C.).');
    let amount: number | null = null;
    if (b.amount !== undefined && b.amount !== null && String(b.amount).trim() !== '') {
      amount = Number(String(b.amount).replace(/,/g, ''));
      if (!Number.isFinite(amount) || amount <= 0 || amount > 10_000_000) throw new HttpError(400, 'Please enter a valid amount.');
      amount = Math.round(amount * 100) / 100;
    }
    const note = String(b.note ?? '').trim().slice(0, 500);
    const [row] = await query<{ id: number }>(
      `INSERT INTO cashin_requests (business_id, created_by, number, gcash_name, amount, note)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [businessId, me.id, number, gcashName, amount, note],
    );
    await notifyOwners(
      businessId,
      me.id,
      {
        title: `Cash-in request${amount ? ` · ${peso(amount)}` : ''}`,
        body: `${prettyNumber(number)} · ${gcashName} — from ${me.name}`,
        url: '/?view=cashin',
        tag: `cashin-${row.id}`,
      },
      url.origin,
    );
    return json({ id: row.id });
  }

  // Names this business has used before for a mobile number (from earlier cash-in requests and
  // receipts). GCash has no public name-lookup API, so this is the store's own customer memory.
  if (path === 'cashin/lookup' && m === 'GET') {
    const me = requireUser(user);
    const businessId = businessScope(me, url.searchParams.get('businessId'));
    const number = cleanMobile(url.searchParams.get('number'));
    const rows = await query<{ name: string; at: string; source: string }>(
      `SELECT name, MAX(at) AS at, MIN(source) AS source FROM (
         SELECT gcash_name AS name, created_at AS at, 'cash-in' AS source
           FROM cashin_requests WHERE business_id = $1 AND number = $2 AND status <> 'cancelled'
         UNION ALL
         SELECT recipient, created_at, 'receipt'
           FROM transactions
          WHERE business_id = $1 AND recipient <> ''
            AND right(regexp_replace(phone, '\\D', '', 'g'), 10) = right($2, 10)
       ) x GROUP BY name ORDER BY MAX(at) DESC LIMIT 3`,
      [businessId, number],
    );
    return json({ names: rows });
  }

  if (parts[0] === 'cashin' && parts.length === 2 && m === 'PATCH') {
    const me = requireUser(user);
    const id = Number(parts[1]);
    const [r] = await query<{ businessId: number; createdBy: number; status: string; number: string; gcashName: string; amount: number | null }>(
      `SELECT business_id AS "businessId", created_by AS "createdBy", status, number, gcash_name AS "gcashName",
              amount::float8 AS amount FROM cashin_requests WHERE id = $1`,
      [id],
    );
    if (!r || (me.role !== 'superadmin' && r.businessId !== me.businessId)) throw new HttpError(404, 'Request not found.');
    const b = await body<{ status: 'done' | 'cancelled' }>(req);
    if (b.status !== 'done' && b.status !== 'cancelled') throw new HttpError(400, 'Invalid status.');
    if (me.role === 'tindera' && (r.createdBy !== me.id || b.status !== 'cancelled')) {
      throw new HttpError(403, 'Only the owner can mark a cash-in as done.');
    }
    if (r.status !== 'pending') throw new HttpError(409, `This request is already ${r.status}.`);
    await query(`UPDATE cashin_requests SET status = $1, handled_by = $2, handled_at = NOW() WHERE id = $3`, [b.status, me.id, id]);
    if (r.createdBy !== me.id) {
      await notifyUsers(
        [r.createdBy],
        {
          title: b.status === 'done' ? 'Cash-in sent ✓' : 'Cash-in cancelled',
          body: `${r.amount ? `${peso(r.amount)} to ` : ''}${prettyNumber(r.number)} · ${r.gcashName}`,
          url: '/?view=cashin',
          tag: `cashin-${id}`,
        },
        url.origin,
      );
    }
    return json({ ok: true });
  }

  // ---------- realtime ----------
  // A tiny "version stamp" of what this user can see. The app polls it every few seconds while
  // visible (and immediately when a push arrives) and reloads only when it changes.
  if (path === 'changes' && m === 'GET') {
    const me = requireUser(user);
    const businessId = businessScope(me, url.searchParams.get('businessId'));
    const own = me.role === 'tindera';
    const [r] = await query<{ t: string | null; tc: number; c: string | null; cc: number; pending: number }>(
      `SELECT (SELECT MAX(updated_at)::text FROM transactions WHERE business_id = $1 AND ($2::int IS NULL OR created_by = $2)) AS t,
              (SELECT COUNT(*)::int FROM transactions WHERE business_id = $1 AND ($2::int IS NULL OR created_by = $2)) AS tc,
              (SELECT MAX(GREATEST(created_at, COALESCE(handled_at, created_at)))::text FROM cashin_requests
                WHERE business_id = $1 AND ($2::int IS NULL OR created_by = $2)) AS c,
              (SELECT COUNT(*)::int FROM cashin_requests WHERE business_id = $1 AND ($2::int IS NULL OR created_by = $2)) AS cc,
              (SELECT COUNT(*)::int FROM cashin_requests
                WHERE business_id = $1 AND status = 'pending' AND ($2::int IS NULL OR created_by = $2)) AS pending`,
      [businessId, own ? me.id : null],
    );
    // Counts are included so deletions are noticed too.
    return json({ receipts: `${r.t ?? ''}|${r.tc}`, cashin: `${r.c ?? ''}|${r.cc}`, pending: r.pending });
  }

  if (path === 'check-ref' && m === 'GET') {
    const me = requireUser(user);
    const businessId = businessScope(me, url.searchParams.get('businessId'));
    const ref = (url.searchParams.get('ref') ?? '').replace(/\s+/g, '');
    const exclude = Number(url.searchParams.get('excludeId') ?? 0);
    if (!ref) return json({ duplicate: null });
    const rows = await query(
      `SELECT t.id, t.ref_no AS "refNo", t.txn_date AS "txnDate", t.recipient, t.type, u.name AS "createdByName"
         FROM transactions t JOIN users u ON u.id = t.created_by
        WHERE t.business_id = $1 AND t.ref_no = $2 AND t.id <> $3 LIMIT 1`,
      [businessId, ref, exclude],
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
      requireManager(me);
      await loadTxn(id, me);
      await query(`DELETE FROM transactions WHERE id = $1`, [id]);
      return json({ ok: true });
    }
  }

  throw new HttpError(404, 'Not found.');
}
