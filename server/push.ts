import { generateVAPIDKeys, sendNotification, WebPushError } from 'web-push';
import { query } from './db.js';

/*
 * Web Push notifications. The VAPID key pair is generated once and kept in app_settings,
 * so no extra environment variables are needed.
 */

export interface PushPayload {
  title: string;
  body: string;
  /** Path the app opens when the notification is tapped, e.g. "/?view=cashin". */
  url: string;
  /** Notifications with the same tag replace each other instead of stacking. */
  tag?: string;
  /** Keep the notification on screen until it is tapped or dismissed (e.g. cash-in requests). */
  sticky?: boolean;
  /** Lets an open app react instantly (chime + "Cash in po!") without waiting for its next check. */
  event?: 'request' | 'remind' | 'done';
  kind?: 'cashin' | 'cashout';
}

let keys: Promise<{ publicKey: string; privateKey: string }> | null = null;

function vapidKeys() {
  keys ??= (async () => {
    const read = () =>
      query<{ key: string; value: string }>(`SELECT key, value FROM app_settings WHERE key IN ('vapid_public', 'vapid_private')`);
    let rows = await read();
    if (rows.length < 2) {
      const k = generateVAPIDKeys();
      // If two servers race, the first insert wins and both read it back.
      await query(
        `INSERT INTO app_settings (key, value) VALUES ('vapid_public', $1), ('vapid_private', $2) ON CONFLICT (key) DO NOTHING`,
        [k.publicKey, k.privateKey],
      );
      rows = await read();
    }
    const get = (k: string) => rows.find((r) => r.key === k)?.value ?? '';
    return { publicKey: get('vapid_public'), privateKey: get('vapid_private') };
  })().catch((e) => {
    keys = null;
    throw e;
  });
  return keys;
}

export async function publicKey() {
  return (await vapidKeys()).publicKey;
}

export async function saveSubscription(userId: number, sub: { endpoint: string; keys: { p256dh: string; auth: string } }) {
  await query(
    `INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth) VALUES ($1, $2, $3, $4)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
    [sub.endpoint, userId, sub.keys.p256dh, sub.keys.auth],
  );
}

export async function removeSubscription(userId: number, endpoint: string) {
  await query(`DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2`, [endpoint, userId]);
}

/**
 * Sends a notification to every device of the given users. Never throws: a failed push must not
 * fail the request that triggered it. Subscriptions the push service says are gone are deleted.
 */
export async function notifyUsers(userIds: number[], payload: PushPayload, origin: string) {
  if (!userIds.length) return;
  try {
    const subs = await query<{ endpoint: string; p256dh: string; auth: string }>(
      `SELECT s.endpoint, s.p256dh, s.auth FROM push_subscriptions s JOIN users u ON u.id = s.user_id
        WHERE s.user_id = ANY($1::int[]) AND u.active`,
      [userIds],
    );
    if (!subs.length) return;
    const { publicKey: pub, privateKey } = await vapidKeys();
    const body = JSON.stringify(payload);
    await Promise.allSettled(
      subs.map((s) =>
        sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, {
          vapidDetails: { subject: origin.startsWith('https:') ? origin : 'mailto:admin@example.com', publicKey: pub, privateKey },
          // If the phone is off or offline, the push service keeps the message for up to 24 h.
          TTL: 24 * 3600,
          urgency: 'high',
          timeout: 5000,
        }).catch(async (e) => {
          if (e instanceof WebPushError && (e.statusCode === 404 || e.statusCode === 410)) {
            await query(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [s.endpoint]);
          } else {
            console.error('push failed', e instanceof Error ? e.message : e);
          }
        }),
      ),
    );
  } catch (e) {
    console.error('notifyUsers failed', e);
  }
}

/** Notify the active owners of a business (optionally excluding whoever triggered it). */
export async function notifyOwners(businessId: number, excludeUserId: number | null, payload: PushPayload, origin: string) {
  const owners = await query<{ id: number }>(
    `SELECT id FROM users WHERE business_id = $1 AND role = 'owner' AND active AND id <> $2`,
    [businessId, excludeUserId ?? 0],
  );
  await notifyUsers(owners.map((o) => o.id), payload, origin);
}
