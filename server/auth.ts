import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { query } from './db.js';

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, keylen: number) => Promise<Buffer>;

export type Role = 'superadmin' | 'owner' | 'tindera';
export interface User {
  id: number;
  username: string;
  name: string;
  role: Role;
  /** null for the super admin */
  businessId: number | null;
  businessName: string | null;
}

export const USER_COLUMNS = `u.id, u.username, u.name, u.role, u.business_id AS "businessId", b.name AS "businessName"`;
export const USER_FROM = `users u LEFT JOIN businesses b ON b.id = u.business_id`;
/** Active account, and (unless super admin) an active business. */
export const USER_ACTIVE = `u.active AND (u.role = 'superadmin' OR b.active)`;

const COOKIE = 'gcash_sid';
const SESSION_DAYS = 30;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, saltB64, hashB64] = stored.split('$');
  if (algo !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scryptAsync(password, Buffer.from(saltB64, 'base64'), expected.length);
  return timingSafeEqual(actual, expected);
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get('cookie') ?? '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function cookieAttrs(req: Request) {
  const secure = new URL(req.url).protocol === 'https:' ? '; Secure' : '';
  return `Path=/; HttpOnly; SameSite=Lax${secure}`;
}

/** Creates a session and returns the Set-Cookie header value. Only a hash of the token is stored. */
export async function createSession(req: Request, userId: number): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await query(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, NOW() + ($3 || ' days')::interval)`, [
    sha256(token),
    userId,
    String(SESSION_DAYS),
  ]);
  // Opportunistic cleanup of expired sessions.
  await query(`DELETE FROM sessions WHERE expires_at < NOW()`);
  return `${COOKIE}=${token}; Max-Age=${SESSION_DAYS * 86400}; ${cookieAttrs(req)}`;
}

export async function destroySession(req: Request): Promise<string> {
  const token = readCookie(req, COOKIE);
  if (token) await query(`DELETE FROM sessions WHERE token_hash = $1`, [sha256(token)]);
  return `${COOKIE}=; Max-Age=0; ${cookieAttrs(req)}`;
}

/** The logged-in, active user for this request, or null. */
export async function currentUser(req: Request): Promise<User | null> {
  const token = readCookie(req, COOKIE);
  if (!token) return null;
  const rows = await query<User>(
    `SELECT ${USER_COLUMNS}
       FROM sessions s JOIN users u ON u.id = s.user_id LEFT JOIN businesses b ON b.id = u.business_id
      WHERE s.token_hash = $1 AND s.expires_at > NOW() AND ${USER_ACTIVE}`,
    [sha256(token)],
  );
  return rows[0] ?? null;
}

export async function endSessionsForUser(userId: number) {
  await query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
}
