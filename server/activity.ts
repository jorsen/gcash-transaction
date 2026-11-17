import type { User } from './auth.js';
import { query } from './db.js';

/**
 * Activity log ("who did what, when") per business. Owners see their own business's log;
 * the super admin sees every business. Logging must never break the action being logged.
 */

export type ActivityCategory = 'auth' | 'receipt' | 'cashin' | 'staff' | 'business';

export interface ActivityInput {
  /** e.g. "cashin.create", "receipt.delete", "auth.login" — the part before the dot is the category. */
  action: `${ActivityCategory}.${string}`;
  /** Human-readable sentence shown in the log, e.g. "Sent a cash-in request · 0917 123 4567 · ₱400.00". */
  summary: string;
  targetType?: 'transaction' | 'cashin' | 'user' | 'business';
  targetId?: number | null;
}

/** Short device label from the User-Agent, e.g. "Android · Chrome", "iPhone · Safari", "Windows · Edge". */
export function deviceLabel(req: Request): string {
  const ua = req.headers.get('user-agent') ?? '';
  const os = /android/i.test(ua)
    ? 'Android'
    : /iphone|ipad|ipod/i.test(ua)
      ? 'iPhone'
      : /windows/i.test(ua)
        ? 'Windows'
        : /mac os/i.test(ua)
          ? 'Mac'
          : /linux/i.test(ua)
            ? 'Linux'
            : '';
  const browser = /edg\//i.test(ua)
    ? 'Edge'
    : /samsungbrowser/i.test(ua)
      ? 'Samsung Internet'
      : /chrome|crios/i.test(ua)
        ? 'Chrome'
        : /firefox|fxios/i.test(ua)
          ? 'Firefox'
          : /safari/i.test(ua)
            ? 'Safari'
            : '';
  return [os, browser].filter(Boolean).join(' · ');
}

export async function logActivity(
  req: Request,
  actor: Pick<User, 'id' | 'name' | 'role'> | null,
  businessId: number | null,
  a: ActivityInput,
) {
  try {
    await query(
      `INSERT INTO activity_log (business_id, user_id, user_name, role, action, summary, target_type, target_id, device)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        businessId,
        actor?.id ?? null,
        actor?.name ?? '',
        actor?.role ?? '',
        a.action,
        a.summary.slice(0, 500),
        a.targetType ?? null,
        a.targetId ?? null,
        deviceLabel(req),
      ],
    );
  } catch (e) {
    console.error('activity log failed', e);
  }
}
