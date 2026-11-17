import { useEffect, useState } from 'react';
import { api } from './api';

export interface LiveStamp {
  /** Changes whenever a visible receipt is added, edited or deleted. */
  receipts: string;
  /** Changes whenever a visible cash-in request is added or handled. */
  cashin: string;
  /** Number of cash-in requests waiting. */
  pending: number;
  /** Kind of the newest waiting request ("cashin" / "cashout"). */
  latestKind: 'cashin' | 'cashout' | null;
}

const POLL_MS = 5000;

/**
 * Realtime updates for one business.
 * - Instantly: when a push notification arrives, the service worker tells the open app to check now.
 * - Otherwise: a tiny check every 5 s while the app is on screen (paused in the background).
 * Screens reload their data when the relevant part of the stamp changes.
 */
export function useLiveStamp(businessId: number | null): LiveStamp | null {
  const [stamp, setStamp] = useState<LiveStamp | null>(null);

  useEffect(() => {
    let stopped = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const check = async () => {
      clearTimeout(timer);
      if (stopped) return;
      if (document.visibilityState === 'visible' && !inFlight) {
        inFlight = true;
        try {
          const s = await api.changes(businessId);
          setStamp((prev) =>
            prev && prev.receipts === s.receipts && prev.cashin === s.cashin && prev.pending === s.pending && prev.latestKind === s.latestKind ? prev : s,
          );
        } catch {
          // offline or logged out: try again next tick
        } finally {
          inFlight = false;
        }
      }
      if (!stopped) timer = setTimeout(check, POLL_MS);
    };

    const onVisible = () => document.visibilityState === 'visible' && check();
    const onSwMessage = (e: MessageEvent) => e.data?.type === 'push-received' && check();

    check();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', check);
    navigator.serviceWorker?.addEventListener('message', onSwMessage);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', check);
      navigator.serviceWorker?.removeEventListener('message', onSwMessage);
    };
  }, [businessId]);

  return stamp;
}
