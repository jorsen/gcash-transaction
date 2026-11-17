import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { api, imageUrl, setUnauthorizedHandler, type StaffUser, type Summary, type Txn, type User } from './api';
import { Activity } from './Activity';
import { AttachReceipt } from './AttachReceipt';
import { exportCsv, uploadLocalRecords } from './backup';
import { Businesses } from './Businesses';
import { CashIn, MaskedName } from './CashIn';
import { countLocal } from './db';
import { isIncoming, peso } from './format';
import { useLiveStamp } from './live';
import { Login } from './Login';
import { disablePush, enablePush, ensurePushSubscription, syncPushSubscription, unlinkPushSubscription, type PushState } from './push';
import { Review } from './Review';
import { announceRequest, playChime, recentLocalAction, recentlyAnnounced, setSoundEnabled, soundEnabled } from './sound';
import { Staff } from './Staff';
import { ActionSheet, Avatar, Banner, Icon, SkeletonRows, useUi } from './ui';

type Biz = { id: number; name: string };
/** Screens pushed on top of the base screen (Businesses for the super admin, Home for everyone else). */
type View =
  | { name: 'biz'; biz: Biz }
  | { name: 'review'; file?: File; id?: number }
  | { name: 'staff' }
  | { name: 'attach'; file: Blob; requestId?: number }
  | { name: 'activity' };
type Open = (v: View) => void;

/** Receipt type filter chips: [value sent to the server, label]. */
const TYPE_FILTERS: [string, string][] = [
  ['', 'All'],
  ['cashin', 'Cash-In'],
  ['cashout', 'Cash-Out'],
  ['Payment', 'Payment'],
  ['Bank Transfer', 'Bank Transfer'],
  ['Other', 'Other'],
];

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const thisMonth = () => ymd(new Date()).slice(0, 7);
const shiftMonth = (ym: string, delta: number) => {
  const [y, m] = ym.split('-').map(Number);
  return ymd(new Date(y, m - 1 + delta, 1)).slice(0, 7);
};
const monthLabel = (ym: string) => {
  const [y, m] = ym.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
};
/** "2026-11-17" -> "Today" / "Yesterday" / "Mon, Nov 17" (+ year if not this year) */
function dayLabel(day: string) {
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (day === ymd(today)) return 'Today';
  if (day === ymd(yesterday)) return 'Yesterday';
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return `${DAYS[date.getDay()]}, ${SHORT_MONTHS[m - 1]} ${d}${y !== today.getFullYear() ? `, ${y}` : ''}`;
}
/** "2026-11-17 17:36" -> "5:36 PM" */
function timeLabel(s: string) {
  const m = s.match(/ (\d{2}):(\d{2})/);
  if (!m) return '';
  const h = Number(m[1]);
  return `${((h + 11) % 12) + 1}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`;
}

const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent);

export function App() {
  const ui = useUi();
  const [session, setSession] = useState<{ user: User | null; needsSetup: boolean } | null>(null);
  const [sessionError, setSessionError] = useState('');
  const [stack, setStack] = useState<View[]>([]);

  const loadSession = useCallback(() => {
    setSessionError('');
    api
      .session()
      .then(setSession)
      .catch((e) => setSessionError(e.message));
  }, []);

  useEffect(() => {
    loadSession();
    setUnauthorizedHandler(() => setSession((s) => (s ? { ...s, user: null } : s)));
  }, [loadSession]);

  // The phone's Back button/gesture goes back one screen instead of leaving the app.
  useEffect(() => {
    const onPop = () => setStack((s) => s.slice(0, -1));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const open: Open = (v) => {
    history.pushState({ sub: true }, '');
    setStack((s) => [...s, v]);
  };
  const close = () => history.back();

  const changePassword = async () => {
    const v = await ui.ask({
      title: 'Change password',
      fields: [
        { name: 'current', label: 'Current password', type: 'password' },
        { name: 'next', label: 'New password (at least 6 characters)', type: 'password' },
      ],
      confirmText: 'Change password',
    });
    if (!v) return;
    try {
      await api.changePassword(v.current, v.next);
      ui.toast('Password changed');
    } catch (e) {
      ui.toast(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  if (!session) {
    return (
      <div className="page center">
        {sessionError ? (
          <div className="login-card">
            <p className="error">{sessionError}</p>
            <button className="btn primary block" onClick={loadSession}>
              Try again
            </button>
          </div>
        ) : (
          <span className="spinner big" />
        )}
      </div>
    );
  }

  if (!session.user) {
    return (
      <Login
        needsSetup={session.needsSetup}
        onLoggedIn={(user) => {
          syncPushSubscription();
          setSession({ user, needsSetup: false });
          setStack([]);
        }}
      />
    );
  }

  const user = session.user;
  const logout = async () => {
    if (!(await ui.confirm({ title: 'Log out?', message: 'You will need your username and password to log in again.', confirmText: 'Log out' }))) return;
    await unlinkPushSubscription();
    await api.logout().catch(() => undefined);
    setSession({ user: null, needsSetup: false });
  };

  const top = stack[stack.length - 1];
  const isSuper = user.role === 'superadmin';
  // The business being worked on: the super admin's chosen one, otherwise the user's own.
  const biz: Biz | null = isSuper
    ? ([...stack].reverse().find((v): v is Extract<View, { name: 'biz' }> => v.name === 'biz')?.biz ?? null)
    : { id: user.businessId as number, name: user.businessName ?? '' };

  if (top?.name === 'activity') {
    return (
      <Activity
        user={user}
        businessId={isSuper ? (biz?.id ?? null) : null}
        businessName={biz?.name ?? ''}
        onBack={close}
        onOpenReceipt={(id) => open({ name: 'review', id })}
      />
    );
  }
  // Super admin opening a receipt from the all-businesses activity log (no business chosen).
  if (top?.name === 'review' && isSuper && !biz) {
    return <Review user={user} businessId={null} file={top.file} id={top.id} onDone={close} />;
  }
  if (!top || !biz) {
    if (isSuper) {
      return (
        <Businesses
          user={user}
          onOpen={(b) => open({ name: 'biz', biz: { id: b.id, name: b.name } })}
          onActivity={() => open({ name: 'activity' })}
          onChangePassword={changePassword}
          onLogout={logout}
        />
      );
    }
    return <Home user={user} biz={biz as Biz} onOpen={open} onLogout={logout} onChangePassword={changePassword} />;
  }
  if (top.name === 'review') {
    return <Review user={user} businessId={isSuper ? biz.id : null} file={top.file} id={top.id} onDone={close} />;
  }
  if (top.name === 'attach') {
    return <AttachReceipt user={user} businessId={isSuper ? biz.id : null} file={top.file} requestId={top.requestId} onDone={close} />;
  }
  if (top.name === 'staff') {
    return <Staff me={user} businessId={isSuper ? biz.id : null} businessName={biz.name} onBack={close} />;
  }
  return <Home user={user} biz={biz} onOpen={open} onLogout={logout} onChangePassword={changePassword} onBack={close} />;
}

function Home({
  user,
  biz,
  onOpen,
  onLogout,
  onChangePassword,
  onBack,
}: {
  user: User;
  biz: Biz;
  onOpen: Open;
  onLogout: () => void;
  onChangePassword: () => void;
  /** Super admin: back to the business list. */
  onBack?: () => void;
}) {
  const ui = useUi();
  const isSuper = user.role === 'superadmin';
  const isOwner = user.role !== 'tindera'; // owner or super admin: sees and manages the whole business
  // Only the owner saves receipts; a tindera's + starts a cash-in / cash-out request instead.
  // Receipts are saved only by processing a tindera's request, so there is no "Add receipt" button.
  // A tindera's + starts a cash-in / cash-out request.
  const canRequest = user.role === 'tindera';
  const scopeId = isSuper ? biz.id : null;
  const [month, setMonth] = useState(thisMonth);
  const [search, setSearch] = useState('');
  const [staffFilter, setStaffFilter] = useState<number | null>(null);
  /** '' = all, 'in' / 'out' = money in / out, or one receipt type. */
  const [typeFilter, setTypeFilter] = useState('');
  const [staff, setStaff] = useState<StaffUser[]>([]);
  const [items, setItems] = useState<Txn[]>([]);
  const [summary, setSummary] = useState<Summary>({ count: 0, inflow: 0, outflow: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [sheet, setSheet] = useState<'scan' | 'account' | null>(null);
  const [localCount, setLocalCount] = useState(0);
  const [uploading, setUploading] = useState('');
  const [installEvt, setInstallEvt] = useState<BeforeInstallPromptEvent | null>(null);
  // Remember the tab while other screens (receipt, attach, staff) are open, so Back returns to it.
  const [tab, setTabState] = useState<'receipts' | 'cashin'>(() => {
    if (new URLSearchParams(location.search).get('view') === 'cashin') return 'cashin';
    try {
      return sessionStorage.getItem('home-tab') === 'cashin' ? 'cashin' : 'receipts';
    } catch {
      return 'receipts';
    }
  });
  const setTab = (t: 'receipts' | 'cashin') => {
    setTabState(t);
    try {
      sessionStorage.setItem('home-tab', t);
    } catch {
      // ignore
    }
  };
  const [pendingCashin, setPendingCashin] = useState(0);
  const [pushState, setPushState] = useState<PushState | null>(null);
  const [pushBusy, setPushBusy] = useState(false);
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);

  // Links from notifications: "/?view=cashin" or "/?txn=123". Handle on load and while the app is open.
  useEffect(() => {
    const openShared = async () => {
      try {
        const cache = await caches.open('shared-receipts');
        const res = await cache.match('/shared-receipt');
        if (!res) return;
        const blob = await res.blob();
        await cache.delete('/shared-receipt');
        if (isOwner) {
          setTab('cashin');
          onOpen({ name: 'attach', file: blob });
          // One-time tip right when they have just used the Share via sheet.
          try {
            if (!localStorage.getItem('share-pin-tip')) {
              localStorage.setItem('share-pin-tip', '1');
              setTimeout(() => ui.toast('Tip: long-press GCash Tracker in "Share via" → Pin, to keep it first', 'info'), 1200);
            }
          } catch {
            // ignore
          }
        } else {
          setTab('cashin');
          ui.toast('Only the owner saves GCash receipts. Send a cash-in / cash-out request instead.', 'info');
        }
      } catch {
        ui.toast('Could not open the shared receipt', 'error');
      }
    };
    const openUrl = (href: string) => {
      const p = new URL(href, location.origin).searchParams;
      if (p.get('share') === '1') openShared();
      if (p.get('share') === 'failed') ui.toast('Open GCash Tracker once, then share again', 'error');
      if (p.get('view') === 'cashin') setTab('cashin');
      const txn = Number(p.get('txn'));
      if (txn) {
        setTab('receipts');
        onOpen({ name: 'review', id: txn });
      }
    };
    if (location.search) {
      openUrl(location.href);
      history.replaceState(history.state, '', location.pathname);
    }
    const onMsg = (e: MessageEvent) => e.data?.type === 'open-url' && openUrl(e.data.url);
    navigator.serviceWorker?.addEventListener('message', onMsg);
    return () => navigator.serviceWorker?.removeEventListener('message', onMsg);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // Re-register this device for push every time the app opens, so notifications keep
    // arriving while the app is closed even if the browser dropped the old subscription.
    if (!isSuper) ensurePushSubscription().then(setPushState).catch(() => setPushState('unsupported'));
  }, [isSuper]);

  /** silent: refresh in the background without the loading skeleton (realtime updates). */
  const load = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      setError('');
      try {
        const r = await api.transactions({ month, search: search.trim(), userId: staffFilter, businessId: scopeId, type: typeFilter });
        setItems(r.items);
        setSummary(r.summary);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [month, search, staffFilter, scopeId, typeFilter],
  );

  // Debounce so typing in the search box doesn't fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => load(), search ? 350 : 0);
    return () => clearTimeout(t);
  }, [load, search]);

  // Realtime: badge count, and reload the receipts list when someone adds/edits/deletes one.
  const live = useLiveStamp(scopeId);
  const lastReceipts = useRef<string | null>(null);
  const lastPending = useRef<number | null>(null);
  const lastRemind = useRef<string | null | undefined>(undefined);

  // Instant alert: the push itself says what happened, so an open owner app rings and says
  // "Cash in po!" the moment it arrives instead of waiting for the next check.
  useEffect(() => {
    if (!isOwner) return;
    const onMsg = (e: MessageEvent) => {
      const d = e.data;
      if (d?.type !== 'push-received' || (d.event !== 'request' && d.event !== 'remind')) return;
      announceRequest(d.kind === 'cashout' ? 'cashout' : 'cashin', false, d.event === 'remind');
      ui.toast(d.event === 'remind' ? (d.kind === 'cashout' ? 'Ate, pa cash-out po! (reminder)' : 'Ate, pa cash-in po! (reminder)') : d.kind === 'cashout' ? 'Ate, pa cash-out po!' : 'Ate, pa cash-in po!', 'info');
    };
    navigator.serviceWorker?.addEventListener('message', onMsg);
    return () => navigator.serviceWorker?.removeEventListener('message', onMsg);
  }, [isOwner, ui]);
  useEffect(() => {
    if (!live) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing from the live stamp
    setPendingCashin(live.pending);
    const receiptCount = Number(live.receipts.split('|')[1] ?? 0);
    const prevReceiptCount = lastReceipts.current === null ? null : Number(lastReceipts.current.split('|')[1] ?? 0);
    if (lastReceipts.current !== null && lastReceipts.current !== live.receipts) load(true);

    // Sounds for things other people did (never for your own actions).
    if (lastPending.current !== null && !recentLocalAction()) {
      if (isOwner && live.pending > lastPending.current && !recentlyAnnounced()) {
        // Chime + "Cash in po!" / "Pa-cash out po!" (unless the push already rang for it)
        announceRequest(live.latestKind ?? 'cashin');
        const n = live.pending - lastPending.current;
        ui.toast(n > 1 ? `${n} new requests` : live.latestKind === 'cashout' ? 'Ate, pa cash-out po!' : 'Ate, pa cash-in po!', 'info');
      } else if (!isOwner && live.pending < lastPending.current) {
        playChime('done');
        ui.toast('The owner handled your cash-in request', 'info');
      }
    }
    if (isOwner && prevReceiptCount !== null && receiptCount > prevReceiptCount && !recentLocalAction()) {
      playChime('receipt');
      ui.toast('New receipt uploaded', 'info');
    }
    // A tindera pressed "Pa cash in po!" again (fallback when push isn't on for this device).
    if (isOwner && lastRemind.current !== undefined && live.lastRemind && live.lastRemind !== lastRemind.current && !recentlyAnnounced()) {
      const kind = live.lastRemind.endsWith('|cashout') ? 'cashout' : 'cashin';
      announceRequest(kind, false, true);
      ui.toast(kind === 'cashout' ? 'Ate, pa cash-out po! (reminder)' : 'Ate, pa cash-in po! (reminder)', 'info');
    }
    lastRemind.current = live.lastRemind;
    lastReceipts.current = live.receipts;
    lastPending.current = live.pending;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live]);

  const [soundOn, setSoundOn] = useState(soundEnabled);
  const toggleSound = () => {
    const next = !soundOn;
    setSoundEnabled(next);
    setSoundOn(next);
    if (next) announceRequest('cashin', true);
    ui.toast(next ? 'Sounds on' : 'Sounds off', 'info');
  };

  useEffect(() => {
    if (isOwner) api.users(scopeId).then((r) => setStaff(r.users)).catch(() => undefined);
    if (!isSuper) countLocal().then(setLocalCount);
  }, [isOwner, isSuper, scopeId]);

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setInstallEvt(e as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    return () => window.removeEventListener('beforeinstallprompt', onPrompt);
  }, []);

  const togglePush = async () => {
    setPushBusy(true);
    try {
      const next = pushState === 'on' ? await disablePush() : await enablePush();
      setPushState(next);
      if (next === 'on') ui.toast('Notifications are on');
      else if (next === 'denied') ui.toast('Notifications are blocked in your browser settings', 'error');
      else ui.toast('Notifications are off', 'info');
    } catch (e) {
      ui.toast(`Could not turn on notifications: ${e instanceof Error ? e.message : String(e)}`, 'error');
    } finally {
      setPushBusy(false);
    }
  };

  const notificationHelp = () =>
    ui.info({
      title: 'Getting notifications when the app is closed',
      message: (
        <div className="help-list">
          <p>
            <strong>Android (Chrome):</strong> Settings → Apps → Chrome → Battery → <em>Unrestricted</em> (Xiaomi: <em>No restrictions</em>;
            Oppo/Realme/Vivo: allow <em>background activity</em> and <em>auto-launch</em>). Also make sure Chrome notifications are allowed.
          </p>
          <p>
            <strong>iPhone:</strong> open GCash Tracker from its Home Screen icon (not Safari). Settings → Notifications → GCash Tracker →
            Allow.
          </p>
          <p>
            <strong>Windows PC:</strong> Chrome/Edge settings → System → turn on <em>Continue running background apps when closed</em>. Turn off
            Focus Assist / Do Not Disturb.
          </p>
          <p>
            <strong>Sound:</strong> while the app is open it plays its own chime. When it's closed, your phone plays its notification
            sound. To make it louder or different on Android: long-press a GCash Tracker notification → <em>Settings</em> → <em>Sound</em>
            (or Settings → Apps → Chrome → Notifications → gcash-transaction.vercel.app). Make sure the phone isn't on silent / Do Not Disturb.
          </p>
          <p>Notifications wait up to 24 hours if the phone is off or offline.</p>
        </div>
      ),
      confirmText: 'Got it',
    });

  /** How to put GCash Tracker first in GCash's "Share via" sheet (Android decides the order, so it's a phone setting). */
  const shareSetupHelp = () =>
    ui.info({
      title: 'Put GCash Tracker first in "Share via"',
      message: (
        <div className="help-list">
          <p>
            <strong>1. Install the app first.</strong> In Chrome, open this site, then ⋮ → <em>Install app</em> / <em>Add to Home screen</em>.
            Only the installed app shows up in Share via. If it's already installed but missing, remove it and install it again once.
          </p>
          <p>
            <strong>2. Pin it (Samsung, Pixel and most Android 10+ phones).</strong> In GCash, after sending, tap <em>Share</em>. In the Share via
            sheet, <em>long-press</em> GCash Tracker → <em>Pin</em>. It then always stays first.
          </p>
          <p>
            <strong>Xiaomi / Redmi / POCO (HyperOS, MIUI):</strong> the Share via sheet puts the apps you share to most often first. Share to
            GCash Tracker 2–3 times and it moves to the front. If you see a long-press <em>Pin</em> option, use it.
          </p>
          <p>
            <strong>Oppo / Realme / Vivo:</strong> long-press GCash Tracker in the share list → <em>Pin</em> or <em>Move to top</em> (if
            offered); otherwise it moves to the front after a few shares.
          </p>
          <p>Android doesn't let any app make itself the default share target, so this is a one-time setting on each owner's phone.</p>
        </div>
      ),
      confirmText: 'Got it',
    });

  const testNotification = () => {
    // Fire and forget: the server waits 10 s and then sends, even if the app is closed meanwhile.
    api.pushTest(10).catch(() => undefined);
    ui.info({
      title: 'Close the app now',
      message: (
        <>
          A test notification will arrive in about <strong>10 seconds</strong>. Close the app (or switch to another app) to check that
          notifications reach you while it's closed. If nothing arrives, tap <em>Notification help</em> in the menu.
        </>
      ),
      confirmText: 'OK',
    });
  };

  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) onOpen({ name: 'review', file });
  };

  const install = async () => {
    if (installEvt) {
      await installEvt.prompt();
      setInstallEvt(null);
    } else {
      ui.info({
        title: 'Add to Home Screen',
        message: (
          <>
            In Safari, tap <strong>Share</strong> (the square with an arrow), then <strong>Add to Home Screen</strong>. Open the app
            from that icon to get notifications.
          </>
        ),
      });
    }
  };

  const uploadLocal = async () => {
    try {
      const n = await uploadLocalRecords((done, total) => setUploading(`Uploading ${done} of ${total}…`));
      setUploading('');
      setLocalCount(0);
      ui.toast(`Uploaded ${n} transaction${n === 1 ? '' : 's'} to the cloud`);
      load();
    } catch (e) {
      setUploading('');
      setLocalCount(await countLocal());
      ui.toast(`Upload stopped: ${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  };

  const canInstall = !isSuper && !isStandalone() && (installEvt !== null || isIos());
  const tinderas = staff.filter((s) => s.role === 'tindera');
  const roleLabel = isSuper ? 'Super admin view' : user.role === 'owner' ? 'Owner' : 'Tindera';

  // Group the list by day, newest first, with a total per day.
  const groups: { day: string; items: Txn[]; out: number; in: number }[] = [];
  for (const t of items) {
    const day = t.txnDate.slice(0, 10);
    let g = groups[groups.length - 1];
    if (!g || g.day !== day) groups.push((g = { day, items: [], out: 0, in: 0 }));
    g.items.push(t);
    if (isIncoming(t.type)) g.in += t.amount;
    else g.out += t.amount;
  }
  const net = summary.inflow - summary.outflow;

  return (
    <div className="page has-bottom-nav">
      <header className="appbar">
        {onBack && (
          <button className="icon-btn" aria-label="Back to businesses" onClick={onBack}>
            <Icon name="back" />
          </button>
        )}
        <div className="appbar-title">
          <h1>{biz.name || 'GCash Tracker'}</h1>
          <small>{isSuper ? roleLabel : `${user.name} · ${roleLabel}`}</small>
        </div>
        <button className="avatar-btn" aria-label="Account and settings" onClick={() => setSheet('account')}>
          {isSuper ? <Icon name="more" /> : <Avatar name={user.name} size={36} />}
        </button>
      </header>

      <main className="content">
        {localCount > 0 && (
          <div className="banner warn">
            <span className="banner-icon">
              <Icon name="download" size={20} />
            </span>
            <span className="banner-text">
              <strong>{localCount}</strong> old record{localCount === 1 ? '' : 's'} saved only on this phone.
            </span>
            <button className="banner-action" onClick={uploadLocal} disabled={Boolean(uploading)}>
              {uploading || 'Upload'}
            </button>
          </div>
        )}
        {pushState === 'off' && (
          <Banner id="push" icon="bell" action={{ label: 'Turn on', onClick: togglePush, busy: pushBusy }}>
            Get notified {isOwner ? 'about new receipts & cash-ins' : 'when your cash-ins are sent'}
          </Banner>
        )}
        {canInstall && (
          <Banner id="install" icon="install" action={{ label: 'Install', onClick: install }}>
            Add GCash Tracker to your home screen
          </Banner>
        )}

        {tab === 'cashin' ? (
          <CashIn
            user={user}
            businessId={scopeId}
            onPendingChange={setPendingCashin}
            liveStamp={live?.cashin ?? null}
            onAttach={(file, requestId) => onOpen({ name: 'attach', file, requestId })}
            onViewReceipt={(id) => onOpen({ name: 'review', id })}
          />
        ) : (
          <>
            <section className="summary">
              <div className="month-nav">
                <button aria-label="Previous month" onClick={() => setMonth((m) => shiftMonth(m, -1))} disabled={Boolean(search)}>
                  <Icon name="chevronLeft" />
                </button>
                <span className="month-label">{search ? 'Search results' : monthLabel(month)}</span>
                <button aria-label="Next month" onClick={() => setMonth((m) => shiftMonth(m, 1))} disabled={Boolean(search) || month >= thisMonth()}>
                  <Icon name="chevronRight" />
                </button>
              </div>
              <div className="summary-grid">
                <div>
                  <div className="summary-sub">Cash-In</div>
                  <div className="summary-value">{peso(summary.outflow)}</div>
                </div>
                <div>
                  <div className="summary-sub">Cash-Out</div>
                  <div className="summary-value">{peso(summary.inflow)}</div>
                </div>
              </div>
              <div className="summary-foot">
                <span>
                  {summary.count} transaction{summary.count === 1 ? '' : 's'}
                </span>
                <span>
                  Net {net < 0 ? '−' : '+'}
                  {peso(Math.abs(net))}
                </span>
              </div>
            </section>

            {isOwner && tinderas.length > 0 && (
              <div className="chips scroll">
                <button className={`chip ${staffFilter === null ? 'active' : ''}`} onClick={() => setStaffFilter(null)}>
                  Everyone
                </button>
                {tinderas.map((s) => (
                  <button key={s.id} className={`chip ${staffFilter === s.id ? 'active' : ''}`} onClick={() => setStaffFilter(s.id)}>
                    {s.name}
                  </button>
                ))}
              </div>
            )}

            <div className="chips scroll type-filter" role="group" aria-label="Filter by type">
              {TYPE_FILTERS.map(([value, label]) => (
                <button key={value || 'all'} className={`chip ${typeFilter === value ? 'active' : ''}`} onClick={() => setTypeFilter(value)}>
                  {label}
                </button>
              ))}
            </div>

            <label className="search-wrap">
              <Icon name="search" size={20} />
              <input
                className="input search"
                type="search"
                placeholder={isOwner ? 'Search name, ref no., note, tindera' : 'Search name, ref no., note'}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>

            {error ? (
              <div className="empty-state">
                <p className="error">{error}</p>
                <button className="btn secondary" onClick={() => load()}>
                  Try again
                </button>
              </div>
            ) : loading && items.length === 0 ? (
              <SkeletonRows />
            ) : items.length === 0 ? (
              <div className="empty-state">
                <span className="empty-icon">
                  <Icon name="receipt" size={40} />
                </span>
                <strong>
                  {search
                    ? 'No matches'
                    : typeFilter
                      ? `No ${TYPE_FILTERS.find(([v]) => v === typeFilter)?.[1] ?? ''} receipts in ${monthLabel(month)}`
                      : `No receipts in ${monthLabel(month)}`}
                </strong>
                {typeFilter && (
                  <button className="btn secondary" onClick={() => setTypeFilter('')}>
                    Show all types
                  </button>
                )}
                {!search && !typeFilter && isOwner && !isSuper && <p>Receipts are saved here when you process a tindera's cash-in or cash-out request.</p>}
              </div>
            ) : (
              groups.map((g) => (
                <section key={g.day} className="day-group">
                  <div className="day-head">
                    <span>{dayLabel(g.day)}</span>
                    <span className="day-total">
                      {g.out > 0 && <span className="out">−{peso(g.out)}</span>}
                      {g.in > 0 && <span className="in">+{peso(g.in)}</span>}
                    </span>
                  </div>
                  <ul className="list">
                    {g.items.map((t) => (
                      <li key={t.id}>
                        <button className="row" onClick={() => onOpen({ name: 'review', id: t.id })}>
                          {t.hasImage ? (
                            <img src={imageUrl(t)} className="thumb" alt="" loading="lazy" />
                          ) : (
                            <span className="thumb placeholder">
                              <Icon name="receipt" size={20} />
                            </span>
                          )}
                          <span className="row-main">
                            {t.recipient ? <MaskedName name={t.recipient} className="row-title" /> : <span className="row-title">{t.type}</span>}
                            <span className="row-sub">
                              {t.type} · {timeLabel(t.txnDate)}
                              {t.refNo ? ` · Ref ${t.refNo}` : ''}
                            </span>
                            {isOwner && <span className="row-by">by {t.requestedByName || t.createdByName}</span>}
                          </span>
                          <span className={`amount ${isIncoming(t.type) ? 'in' : 'out'}`}>
                            {isIncoming(t.type) ? '+' : '−'}
                            {peso(t.amount)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ))
            )}
          </>
        )}
      </main>

      <nav className="bottom-nav" aria-label="Main">
        <button className={tab === 'receipts' ? 'active' : ''} aria-current={tab === 'receipts'} onClick={() => setTab('receipts')}>
          <Icon name="receipt" />
          <span>Receipts</span>
        </button>
        {canRequest ? (
          <button
            className="fab"
            aria-label="New cash-in / cash-out request"
            onClick={() => {
              setTab('cashin');
              window.scrollTo({ top: 0, behavior: 'smooth' });
            }}
          >
            <Icon name="plus" size={30} />
          </button>
        ) : null}
        <button className={tab === 'cashin' ? 'active' : ''} aria-current={tab === 'cashin'} onClick={() => setTab('cashin')}>
          <span className="nav-icon">
            <Icon name="cash" />
            {pendingCashin > 0 && <span className="nav-badge">{pendingCashin}</span>}
          </span>
          <span>Cash-in</span>
        </button>
      </nav>

      <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={onPick} />
      <input ref={galleryRef} type="file" accept="image/*" hidden onChange={onPick} />

      {sheet === 'scan' && (
        <ActionSheet
          title="Add a GCash receipt"
          onClose={() => setSheet(null)}
          actions={[
            { icon: 'camera', label: 'Take a photo', hint: 'Use the camera on a printed or on-screen receipt', onClick: () => cameraRef.current?.click() },
            { icon: 'image', label: 'Choose from gallery', hint: 'Pick a GCash receipt screenshot', onClick: () => galleryRef.current?.click() },
          ]}
        />
      )}
      {sheet === 'account' && (
        <ActionSheet
          title={isSuper ? biz.name : `${user.name} · ${roleLabel}`}
          onClose={() => setSheet(null)}
          actions={[
            ...(isOwner ? [{ icon: 'users' as const, label: 'Staff accounts', hint: 'Add tinderas, reset passwords', onClick: () => onOpen({ name: 'staff' }) }] : []),
            ...(isOwner ? [{ icon: 'more' as const, label: 'Activity log', hint: 'Who did what, and when', onClick: () => onOpen({ name: 'activity' }) }] : []),
            ...(isOwner
              ? [{ icon: 'image' as const, label: 'Share from GCash: setup', hint: 'Put GCash Tracker first in "Share via"', onClick: shareSetupHelp }]
              : []),
            ...(isOwner
              ? [{ icon: 'download' as const, label: 'Export to Excel', hint: `CSV of ${search ? 'these search results' : monthLabel(month)}`, onClick: () => exportCsv(items, search ? 'search' : month) }]
              : []),
            ...(pushState === 'on'
              ? [{ icon: 'bell' as const, label: 'Send test notification', hint: 'Arrives in 10 s — close the app to check', onClick: testNotification }]
              : []),
            ...(pushState && pushState !== 'unsupported' && pushState !== 'needs-install' && pushState !== 'denied'
              ? [{ icon: 'bell' as const, label: pushState === 'on' ? 'Turn off notifications' : 'Turn on notifications', onClick: togglePush }]
              : []),
            {
              icon: 'bell' as const,
              label: soundOn ? 'Sounds: On' : 'Sounds: Off',
              hint: soundOn ? 'Chime + "Ate, pa cash-in po!" for new requests while the app is open' : 'Tap to turn sounds back on',
              onClick: toggleSound,
            },
            ...(!isSuper ? [{ icon: 'bell' as const, label: 'Notification help', hint: 'If notifications don’t arrive when the app is closed', onClick: notificationHelp }] : []),
            ...(!isSuper
              ? [
                  { icon: 'key' as const, label: 'Change password', onClick: onChangePassword },
                  { icon: 'logout' as const, label: 'Log out', onClick: onLogout },
                ]
              : []),
          ]}
        />
      )}
    </div>
  );
}
