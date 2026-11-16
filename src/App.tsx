import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { isIncoming, peso, prettyDate } from './format';
import { exportBackup, exportCsv, importBackup } from './backup';
import { listTxns, type Txn } from './db';
import { Review } from './Review';
import { BlobImage } from './BlobImage';

type View = { name: 'home' } | { name: 'review'; file?: File; id?: number };

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const currentMonth = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;

const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent);

export function App() {
  const [view, setView] = useState<View>({ name: 'home' });

  // The phone's Back button/gesture closes the review screen instead of leaving the app.
  useEffect(() => {
    const onPop = () => setView({ name: 'home' });
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const open = (v: Exclude<View, { name: 'home' }>) => {
    history.pushState({ review: true }, '');
    setView(v);
  };
  const close = () => history.back();

  if (view.name === 'review') {
    return <Review file={view.file} id={view.id} onDone={close} />;
  }
  return <Home onOpen={open} />;
}

function Home({ onOpen }: { onOpen: (v: { name: 'review'; file?: File; id?: number }) => void }) {
  const [items, setItems] = useState<Txn[]>([]);
  const [search, setSearch] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [installEvt, setInstallEvt] = useState<BeforeInstallPromptEvent | null>(null);
  const [showIosHint, setShowIosHint] = useState(false);
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);
  const restoreRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    listTxns(search).then(setItems);
  }, [search]);

  useEffect(load, [load]);

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setInstallEvt(e as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    return () => window.removeEventListener('beforeinstallprompt', onPrompt);
  }, []);

  const month = currentMonth();
  const thisMonth = items.filter((t) => t.txnDate.startsWith(month));
  const inflow = thisMonth.filter((t) => isIncoming(t.type)).reduce((s, t) => s + t.amount, 0);
  const outflow = thisMonth.filter((t) => !isIncoming(t.type)).reduce((s, t) => s + t.amount, 0);

  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) onOpen({ name: 'review', file });
  };

  const onRestore = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const { added, skipped } = await importBackup(file);
      alert(`Restored ${added} transaction(s).${skipped ? ` Skipped ${skipped} already saved.` : ''}`);
      load();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  const install = async () => {
    if (installEvt) {
      await installEvt.prompt();
      setInstallEvt(null);
    } else {
      setShowIosHint(true);
    }
  };

  const canInstall = !isStandalone() && (installEvt !== null || isIos());

  return (
    <div className="page">
      <header className="appbar">
        <h1>GCash Tracker</h1>
        <div className="menu-wrap">
          <button className="icon-btn" aria-label="Menu" onClick={() => setMenuOpen((o) => !o)}>
            ⋮
          </button>
          {menuOpen && (
            <div className="menu" onClick={() => setMenuOpen(false)}>
              <button onClick={exportCsv}>Export to Excel (CSV)</button>
              <button onClick={exportBackup}>Back up (with images)</button>
              <button onClick={() => restoreRef.current?.click()}>Restore backup</button>
            </div>
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

        <section className="summary">
          <div className="summary-label">This month · {thisMonth.length} transactions</div>
          <div className="summary-row">
            <div>
              <div className="summary-sub">Money out</div>
              <div className="summary-value">{peso(outflow)}</div>
            </div>
            <div>
              <div className="summary-sub">Money in</div>
              <div className="summary-value">{peso(inflow)}</div>
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
        <input ref={restoreRef} type="file" accept="application/json,.json" hidden onChange={onRestore} />

        <input
          className="input search"
          type="search"
          placeholder="Search name, ref no., note…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        {items.length === 0 ? (
          <p className="empty">
            {search ? 'No matches.' : 'No transactions yet.\nCapture a GCash receipt or pick a screenshot from your gallery.'}
          </p>
        ) : (
          <ul className="list">
            {items.map((t) => (
              <li key={t.id}>
                <button className="row" onClick={() => onOpen({ name: 'review', id: t.id })}>
                  <BlobImage blob={t.image} className="thumb" />
                  <span className="row-main">
                    <span className="row-title">{t.recipient || t.type}</span>
                    <span className="row-sub">
                      {t.type} · {prettyDate(t.txnDate)}
                    </span>
                    {t.refNo && <span className="row-sub">Ref {t.refNo}</span>}
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
