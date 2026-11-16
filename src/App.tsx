import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { api, imageUrl, setUnauthorizedHandler, type StaffUser, type Summary, type Txn, type User } from './api';
import { exportCsv, uploadLocalRecords } from './backup';
import { countLocal } from './db';
import { isIncoming, peso, prettyDate } from './format';
import { Login } from './Login';
import { Review } from './Review';
import { Staff } from './Staff';

type View = { name: 'home' } | { name: 'review'; file?: File; id?: number } | { name: 'staff' };

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const thisMonth = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
const shiftMonth = (ym: string, delta: number) => {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
const monthLabel = (ym: string) => {
  const [y, m] = ym.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
};

const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent);

export function App() {
  const [session, setSession] = useState<{ user: User | null; needsSetup: boolean } | null>(null);
  const [sessionError, setSessionError] = useState('');
  const [view, setView] = useState<View>({ name: 'home' });

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

  // The phone's Back button/gesture returns to the list instead of leaving the app.
  useEffect(() => {
    const onPop = () => setView({ name: 'home' });
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const open = (v: Exclude<View, { name: 'home' }>) => {
    history.pushState({ sub: true }, '');
    setView(v);
  };
  const close = () => history.back();

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
          setSession({ user, needsSetup: false });
          setView({ name: 'home' });
        }}
      />
    );
  }

  const user = session.user;
  const logout = async () => {
    await api.logout().catch(() => undefined);
    setSession({ user: null, needsSetup: false });
  };

  if (view.name === 'review') return <Review user={user} file={view.file} id={view.id} onDone={close} />;
  if (view.name === 'staff') return <Staff onBack={close} />;
  return <Home user={user} onOpen={open} onLogout={logout} />;
}

function Home({
  user,
  onOpen,
  onLogout,
}: {
  user: User;
  onOpen: (v: { name: 'review'; file?: File; id?: number } | { name: 'staff' }) => void;
  onLogout: () => void;
}) {
  const isOwner = user.role === 'owner';
  const [month, setMonth] = useState(thisMonth);
  const [search, setSearch] = useState('');
  const [staffFilter, setStaffFilter] = useState<number | null>(null);
  const [staff, setStaff] = useState<StaffUser[]>([]);
  const [items, setItems] = useState<Txn[]>([]);
  const [summary, setSummary] = useState<Summary>({ count: 0, inflow: 0, outflow: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [localCount, setLocalCount] = useState(0);
  const [uploading, setUploading] = useState('');
  const [installEvt, setInstallEvt] = useState<BeforeInstallPromptEvent | null>(null);
  const [showIosHint, setShowIosHint] = useState(false);
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const r = await api.transactions({ month, search: search.trim(), userId: staffFilter });
      setItems(r.items);
      setSummary(r.summary);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [month, search, staffFilter]);

  // Debounce so typing in the search box doesn't fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(load, search ? 350 : 0);
    return () => clearTimeout(t);
  }, [load, search]);

  useEffect(() => {
    if (isOwner) api.users().then((r) => setStaff(r.users)).catch(() => undefined);
    countLocal().then(setLocalCount);
  }, [isOwner]);

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setInstallEvt(e as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    return () => window.removeEventListener('beforeinstallprompt', onPrompt);
  }, []);

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
      setShowIosHint(true);
    }
  };

  const uploadLocal = async () => {
    try {
      const n = await uploadLocalRecords((done, total) => setUploading(`Uploading ${done} of ${total}…`));
      setUploading('');
      setLocalCount(0);
      alert(`Uploaded ${n} transaction(s) to the cloud.`);
      load();
    } catch (e) {
      setUploading('');
      setLocalCount(await countLocal());
      alert(`Upload stopped: ${e instanceof Error ? e.message : String(e)}\nThe rest are still on this device. Try again later.`);
    }
  };

  const changePassword = async () => {
    const current = prompt('Current password:');
    if (!current) return;
    const next = prompt('New password (at least 6 characters):');
    if (!next) return;
    try {
      await api.changePassword(current, next);
      alert('Password changed.');
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  };

  const canInstall = !isStandalone() && (installEvt !== null || isIos());
  const tinderas = staff.filter((s) => s.role === 'tindera');

  return (
    <div className="page">
      <header className="appbar">
        <div className="appbar-title">
          <h1>GCash Tracker</h1>
          <small>
            {user.name} · {isOwner ? 'Owner' : 'Tindera'}
          </small>
        </div>
        <div className="menu-wrap">
          <button className="icon-btn" aria-label="Menu" onClick={() => setMenuOpen((o) => !o)}>
            ⋮
          </button>
          {menuOpen && (
            <>
              <div className="menu-backdrop" onClick={() => setMenuOpen(false)} />
              <div className="menu" onClick={() => setMenuOpen(false)}>
                {isOwner && <button onClick={() => onOpen({ name: 'staff' })}>Staff accounts</button>}
                {isOwner && (
                  <button onClick={() => exportCsv(items, search ? 'search' : month)}>Export to Excel (CSV)</button>
                )}
                <button onClick={changePassword}>Change password</button>
                <button onClick={onLogout}>Log out</button>
              </div>
            </>
          )}
        </div>
      </header>

      <main className="content">
        {canInstall && (
          <button className="install-banner" onClick={install}>
            <span>📲</span>
            <span>
              <strong>Install app</strong>
              <br />
              <small>Add GCash Tracker to your home screen</small>
            </span>
          </button>
        )}
        {showIosHint && (
          <div className="notice" onClick={() => setShowIosHint(false)}>
            In Safari, tap <strong>Share</strong> (the square with an arrow), then <strong>Add to Home Screen</strong>.
          </div>
        )}
        {localCount > 0 && (
          <div className="notice column">
            <span>
              <strong>{localCount}</strong> transaction{localCount === 1 ? ' is' : 's are'} saved only on this device (from the
              old version). Upload them so they show on all devices.
            </span>
            <button className="btn primary block" onClick={uploadLocal} disabled={Boolean(uploading)}>
              {uploading || 'Upload to cloud'}
            </button>
          </div>
        )}

        <section className="summary">
          <div className="month-nav">
            <button aria-label="Previous month" onClick={() => setMonth((m) => shiftMonth(m, -1))} disabled={Boolean(search)}>
              ‹
            </button>
            <span>
              {search ? 'Search results' : monthLabel(month)} · {summary.count} transaction{summary.count === 1 ? '' : 's'}
            </span>
            <button
              aria-label="Next month"
              onClick={() => setMonth((m) => shiftMonth(m, 1))}
              disabled={Boolean(search) || month >= thisMonth()}
            >
              ›
            </button>
          </div>
          <div className="summary-row">
            <div>
              <div className="summary-sub">Money out</div>
              <div className="summary-value">{peso(summary.outflow)}</div>
            </div>
            <div>
              <div className="summary-sub">Money in</div>
              <div className="summary-value">{peso(summary.inflow)}</div>
            </div>
          </div>
        </section>

        <div className="actions">
          <button className="btn primary" onClick={() => cameraRef.current?.click()}>
            <span className="btn-icon">📷</span>Capture Receipt
          </button>
          <button className="btn secondary" onClick={() => galleryRef.current?.click()}>
            <span className="btn-icon">🖼️</span>From Gallery
          </button>
        </div>
        <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={onPick} />
        <input ref={galleryRef} type="file" accept="image/*" hidden onChange={onPick} />

        {isOwner && tinderas.length > 0 && (
          <div className="chips scroll">
            <button className={`chip ${staffFilter === null ? 'active' : ''}`} onClick={() => setStaffFilter(null)}>
              Everyone
            </button>
            {staff.map((s) => (
              <button key={s.id} className={`chip ${staffFilter === s.id ? 'active' : ''}`} onClick={() => setStaffFilter(s.id)}>
                {s.name}
              </button>
            ))}
          </div>
        )}

        <input
          className="input search"
          type="search"
          placeholder={isOwner ? 'Search name, ref no., note, tindera…' : 'Search name, ref no., note…'}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        {error ? (
          <div className="notice column">
            <span className="error">{error}</span>
            <button className="btn secondary block" onClick={load}>
              Try again
            </button>
          </div>
        ) : loading && items.length === 0 ? (
          <div className="center">
            <span className="spinner big" />
          </div>
        ) : items.length === 0 ? (
          <p className="empty">
            {search ? 'No matches.' : `No transactions in ${monthLabel(month)}.\nCapture a GCash receipt or pick a screenshot from your gallery.`}
          </p>
        ) : (
          <ul className="list">
            {items.map((t) => (
              <li key={t.id}>
                <button className="row" onClick={() => onOpen({ name: 'review', id: t.id })}>
                  {t.hasImage ? (
                    <img src={imageUrl(t)} className="thumb" alt="" loading="lazy" />
                  ) : (
                    <span className="thumb placeholder" />
                  )}
                  <span className="row-main">
                    <span className="row-title">{t.recipient || t.type}</span>
                    <span className="row-sub">
                      {t.type} · {prettyDate(t.txnDate)}
                    </span>
                    <span className="row-sub">
                      {t.refNo ? `Ref ${t.refNo}` : ''}
                      {isOwner ? `${t.refNo ? ' · ' : ''}by ${t.createdByName}` : ''}
                    </span>
                  </span>
                  <span className={`amount ${isIncoming(t.type) ? 'in' : 'out'}`}>
                    {isIncoming(t.type) ? '+' : '−'}
                    {peso(t.amount)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
