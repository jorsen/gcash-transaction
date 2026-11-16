import { api } from './api';

export type PushState = 'unsupported' | 'needs-install' | 'denied' | 'off' | 'on';

const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;

function supported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

/** Current notification state for this device. */
export async function getPushState(): Promise<PushState> {
  // iPhone/iPad only allow web push for apps added to the Home Screen.
  if (isIos() && !isStandalone()) return 'needs-install';
  if (!supported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  return sub && Notification.permission === 'granted' ? 'on' : 'off';
}

function urlBase64ToUint8Array(base64: string) {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** Asks for permission (must be called from a tap) and registers this device for notifications. */
export async function enablePush(): Promise<PushState> {
  if (!supported()) return 'unsupported';
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'off';
  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await api.pushKey();
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
  }
  await api.pushSubscribe(sub.toJSON());
  await api.pushTest(0).catch(() => undefined);
  return 'on';
}

export async function disablePush(): Promise<PushState> {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await api.pushUnsubscribe(sub.endpoint).catch(() => undefined);
    await sub.unsubscribe();
  }
  return 'off';
}

/**
 * Called every time the app opens. If notifications are allowed, makes sure this device still has a
 * push subscription (re-creating it if the browser dropped it) and that the server has it, so pushes
 * keep arriving while the app is closed. Returns the resulting state.
 */
export async function ensurePushSubscription(): Promise<PushState> {
  const state = await getPushState();
  if (state === 'unsupported' || state === 'needs-install' || state === 'denied') return state;
  if (Notification.permission !== 'granted') return 'off';
  try {
    // ready never resolves if the service worker is not running (e.g. dev mode), so don't wait forever.
    const reg = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("no service worker")), 8000)),
    ]);
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const { publicKey } = await api.pushKey();
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
    }
    await api.pushSubscribe(sub.toJSON());
    return 'on';
  } catch {
    return state;
  }
}

/** Re-sends this device's subscription after login, so it's linked to whoever is logged in now. */
export async function syncPushSubscription() {
  try {
    if (!supported() || Notification.permission !== 'granted') return;
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (sub) await api.pushSubscribe(sub.toJSON());
  } catch {
    // best effort
  }
}

/** Unlinks this device before logging out, so the next person on this phone doesn't get our notifications. */
export async function unlinkPushSubscription() {
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (sub) await api.pushUnsubscribe(sub.endpoint);
  } catch {
    // best effort
  }
}
