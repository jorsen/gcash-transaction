import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, type Business, type User } from './api';
import { PasswordInput } from './PasswordInput';
import { ActionSheet, Avatar, Icon, SkeletonRows, useUi } from './ui';

/** Super admin home: all businesses, add a business (with its first owner), activate/deactivate. */
export function Businesses({
  user,
  onOpen,
  onActivity,
  onChangePassword,
  onLogout,
}: {
  user: User;
  onOpen: (b: Business) => void;
  /** Activity log across all businesses. */
  onActivity: () => void;
  onChangePassword: () => void;
  onLogout: () => void;
}) {
  const ui = useUi();
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
      await ui.info({
        title: `${form.name} created`,
        message: `Give these owner login details to ${form.ownerName}:`,
        copyText: `Username: ${form.ownerUsername.trim().toLowerCase()}\nPassword: ${form.ownerPassword}`,
        confirmText: 'Done',
      });
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
      !(await ui.confirm({
        title: `Deactivate ${b.name}?`,
        message: "Its owners and tinderas are logged out and can't log in until you activate it again. Its records are kept.",
        confirmText: 'Deactivate',
        danger: true,
      }))
    )
      return;
    try {
      await api.updateBusiness(b.id, { active: !b.active });
      ui.toast(b.active ? `${b.name} deactivated` : `${b.name} activated`, 'info');
      load();
    } catch (err) {
      ui.toast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const rename = async (b: Business) => {
    const v = await ui.ask({ title: 'Rename business', fields: [{ name: 'name', label: 'Business name', value: b.name }], confirmText: 'Save' });
    const name = v?.name.trim();
    if (!name || name === b.name) return;
    try {
      await api.updateBusiness(b.id, { name });
      ui.toast('Business renamed');
      load();
    } catch (err) {
      ui.toast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  return (
    <div className="page">
      <header className="appbar">
        <div className="appbar-title">
          <h1>Businesses</h1>
          <small>{user.name} · Super admin</small>
        </div>
        <button className="avatar-btn" aria-label="Account" onClick={() => setMenuOpen(true)}>
          <Avatar name={user.name} size={36} />
        </button>
      </header>

      <main className="content">
        {menuOpen && (
          <ActionSheet
            title={`${user.name} · Super admin`}
            onClose={() => setMenuOpen(false)}
            actions={[
              { icon: 'more', label: 'Activity log', hint: 'All businesses', onClick: onActivity },
              { icon: 'key', label: 'Change password', onClick: onChangePassword },
              { icon: 'logout', label: 'Log out', onClick: onLogout },
            ]}
          />
        )}
        {!showAdd ? (
          <button className="btn primary block" onClick={() => setShowAdd(true)}>
            <Icon name="plus" size={20} /> Add business
          </button>
        ) : (
          <form className="card form" onSubmit={add}>
            <div className="card-head">
              <h2>New business</h2>
              <button type="button" className="icon-btn subtle" aria-label="Close" onClick={() => setShowAdd(false)}>
                <Icon name="close" size={18} />
              </button>
            </div>
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
              <PasswordInput value={form.ownerPassword} onChange={(e) => set('ownerPassword', e.target.value)} autoComplete="new-password" required />
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
          <SkeletonRows count={3} />
        ) : items.length === 0 ? (
          <p className="empty">No businesses yet.{'\n'}Add the first one above.</p>
        ) : (
          <ul className="list">
            {items.map((b) => (
              <li key={b.id} className={`staff-row ${b.active ? '' : 'inactive'}`}>
                <button className="biz-open" onClick={() => onOpen(b)} disabled={!b.active}>
                  <span className="biz-icon">
                    <Icon name="store" size={22} />
                  </span>
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
                  {b.active && <Icon name="chevronRight" className="chevron" />}
                </button>
                <div className="staff-actions">
                  <button className="pill-btn" onClick={() => rename(b)}>
                    <Icon name="edit" size={16} /> Rename
                  </button>
                  <button className={`pill-btn ${b.active ? 'danger' : ''}`} onClick={() => toggleActive(b)}>
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
