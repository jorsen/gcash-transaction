import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, type Business, type User } from './api';

/** Super admin home: all businesses, add a business (with its first owner), activate/deactivate. */
export function Businesses({
  user,
  onOpen,
  onChangePassword,
  onLogout,
}: {
  user: User;
  onOpen: (b: Business) => void;
  onChangePassword: () => void;
  onLogout: () => void;
}) {
  const [items, setItems] = useState<Business[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ name: '', ownerName: '', ownerUsername: '', ownerPassword: '' });
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setError('');
    api
      .businesses()
      .then((r) => setItems(r.businesses))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);
  useEffect(load, [load]);

  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setFormError('');
    setBusy(true);
    try {
      await api.addBusiness(form);
      alert(
        `Business "${form.name}" created.\n\nOwner login:\nUsername: ${form.ownerUsername.trim().toLowerCase()}\nPassword: ${form.ownerPassword}\n\nGive these to ${form.ownerName}.`,
      );
      setForm({ name: '', ownerName: '', ownerUsername: '', ownerPassword: '' });
      setShowAdd(false);
      load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const toggleActive = async (b: Business) => {
    if (
      b.active &&
      !confirm(`Deactivate "${b.name}"?\n\nIts owners and tinderas are logged out and can't log in until you activate it again. Its records are kept.`)
    )
      return;
    try {
      await api.updateBusiness(b.id, { active: !b.active });
      load();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  const rename = async (b: Business) => {
    const name = prompt('Business name:', b.name)?.trim();
    if (!name || name === b.name) return;
    try {
      await api.updateBusiness(b.id, { name });
      load();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="page">
      <header className="appbar">
        <div className="appbar-title">
          <h1>Businesses</h1>
          <small>{user.name} · Super admin</small>
        </div>
        <div className="menu-wrap">
          <button className="icon-btn" aria-label="Menu" onClick={() => setMenuOpen((o) => !o)}>
            ⋮
          </button>
          {menuOpen && (
            <>
              <div className="menu-backdrop" onClick={() => setMenuOpen(false)} />
              <div className="menu" onClick={() => setMenuOpen(false)}>
                <button onClick={onChangePassword}>Change password</button>
                <button onClick={onLogout}>Log out</button>
              </div>
            </>
          )}
        </div>
      </header>

      <main className="content">
        {!showAdd ? (
          <button className="btn primary block" onClick={() => setShowAdd(true)}>
            ＋ Add business
          </button>
        ) : (
          <form className="card form" onSubmit={add}>
            <h2>New business</h2>
            <label className="field">
              <span className="label">Business name</span>
              <input className="input" value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Rosa Sari-Sari Store" required />
            </label>
            <label className="field">
              <span className="label">Owner's name</span>
              <input className="input" value={form.ownerName} onChange={(e) => set('ownerName', e.target.value)} placeholder="e.g. Rosa" required />
            </label>
            <label className="field">
              <span className="label">Owner's username</span>
              <input
                className="input"
                value={form.ownerUsername}
                onChange={(e) => set('ownerUsername', e.target.value)}
                placeholder="e.g. rosa"
                autoCapitalize="none"
                autoCorrect="off"
                autoComplete="off"
                required
              />
            </label>
            <label className="field">
              <span className="label">Owner's password (at least 6 characters)</span>
              <input className="input" value={form.ownerPassword} onChange={(e) => set('ownerPassword', e.target.value)} autoComplete="new-password" required />
            </label>
            {formError && <div className="error">{formError}</div>}
            <div className="actions">
              <button type="button" className="btn secondary" onClick={() => setShowAdd(false)}>
                Cancel
              </button>
              <button className="btn primary" disabled={busy}>
                {busy ? 'Please wait…' : 'Create business'}
              </button>
            </div>
          </form>
        )}

        {error ? (
          <div className="notice column">
            <span className="error">{error}</span>
            <button className="btn secondary block" onClick={load}>
              Try again
            </button>
          </div>
        ) : loading ? (
          <div className="center">
            <span className="spinner big" />
          </div>
        ) : items.length === 0 ? (
          <p className="empty">No businesses yet.{'\n'}Add the first one above.</p>
        ) : (
          <ul className="list">
            {items.map((b) => (
              <li key={b.id} className={`staff-row ${b.active ? '' : 'inactive'}`}>
                <button className="biz-open" onClick={() => onOpen(b)} disabled={!b.active}>
                  <span className="row-main">
                    <span className="row-title">
                      {b.name} {!b.active && <span className="badge muted-badge">Deactivated</span>}
                    </span>
                    <span className="row-sub">Owner: {b.owners || '—'}</span>
                    <span className="row-sub">
                      {b.tinderaCount} tindera{b.tinderaCount === 1 ? '' : 's'} · {b.txnCount} transaction
                      {b.txnCount === 1 ? '' : 's'}
                    </span>
                  </span>
                  {b.active && <span className="chevron">›</span>}
                </button>
                <div className="staff-actions">
                  <button className="link" onClick={() => rename(b)}>
                    Rename
                  </button>
                  <button className={`link ${b.active ? 'danger-text' : ''}`} onClick={() => toggleActive(b)}>
                    {b.active ? 'Deactivate' : 'Activate'}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
