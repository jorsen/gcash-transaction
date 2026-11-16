import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, type StaffUser, type User } from './api';
import { PasswordInput } from './PasswordInput';
import { Avatar, Icon, useUi } from './ui';

/**
 * Staff of one business.
 * - Owner: add tinderas, reset their passwords, activate/deactivate them.
 * - Super admin: the same for any business, and can also add/manage owners.
 */
export function Staff({
  me,
  businessId,
  businessName,
  onBack,
}: {
  me: User;
  businessId: number | null;
  businessName: string;
  onBack: () => void;
}) {
  const ui = useUi();
  const isSuper = me.role === 'superadmin';
  const [formOpen, setFormOpen] = useState(false);
  const [users, setUsers] = useState<StaffUser[]>([]);
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'tindera' | 'owner'>('tindera');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api
      .users(businessId)
      .then((r) => setUsers(r.users))
      .catch((e) => setError(e.message));
  }, [businessId]);
  useEffect(load, [load]);

  /** Owners may manage tinderas and themselves; the super admin may manage everyone in the business. */
  const canManage = (u: StaffUser) => isSuper || u.role === 'tindera' || u.id === me.id;

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api.addUser({ name, username, password, role: isSuper ? role : 'tindera', businessId });
      await ui.info({
        title: `${role === 'owner' && isSuper ? 'Owner' : 'Tindera'} account created`,
        message: `Give these login details to ${name}:`,
        copyText: `Username: ${username.trim().toLowerCase()}\nPassword: ${password}`,
        confirmText: 'Done',
      });
      setFormOpen(false);
      setName('');
      setUsername('');
      setPassword('');
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const resetPassword = async (u: StaffUser) => {
    const v = await ui.ask({
      title: `Reset ${u.name}'s password`,
      message: u.id !== me.id ? 'They will be logged out on all their devices.' : undefined,
      fields: [{ name: 'pw', label: 'New password (at least 6 characters)', type: 'password' }],
      confirmText: 'Reset password',
    });
    if (!v) return;
    try {
      await api.updateUser(u.id, { password: v.pw });
      await ui.info({
        title: 'Password changed',
        message: `New login details for ${u.name}:`,
        copyText: `Username: ${u.username}\nPassword: ${v.pw}`,
        confirmText: 'Done',
      });
    } catch (err) {
      ui.toast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const toggleActive = async (u: StaffUser) => {
    if (
      u.active &&
      !(await ui.confirm({
        title: `Deactivate ${u.name}?`,
        message: "They'll be logged out and can't log in until you activate them again. Their transactions are kept.",
        confirmText: 'Deactivate',
        danger: true,
      }))
    )
      return;
    try {
      await api.updateUser(u.id, { active: !u.active });
      ui.toast(u.active ? `${u.name} deactivated` : `${u.name} activated`, 'info');
      load();
    } catch (err) {
      ui.toast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  return (
    <div className="page">
      <header className="appbar">
        <button className="icon-btn" aria-label="Back" onClick={onBack}>
          <Icon name="back" />
        </button>
        <div className="appbar-title">
          <h1>Staff accounts</h1>
          <small>{businessName}</small>
        </div>
        <span className="icon-btn" />
      </header>

      <main className="content">
        <ul className="list">
          {users.map((u) => (
            <li key={u.id} className={`staff-row ${u.active ? '' : 'inactive'}`}>
              <div className="staff-head">
              <Avatar name={u.name} />
              <div className="row-main">
                <span className="row-title">
                  {u.name} {u.role === 'owner' && <span className="badge">Owner</span>}
                  {!u.active && <span className="badge muted-badge">Deactivated</span>}
                </span>
                <span className="row-sub">
                  @{u.username} · {u.txnCount} transaction{u.txnCount === 1 ? '' : 's'}
                </span>
                <span className={`push-pill ${u.pushDevices > 0 ? 'on' : 'off'}`}>
                  {u.pushDevices > 0
                    ? `🔔 Notifications on${u.pushDevices > 1 ? ` · ${u.pushDevices} devices` : ''}`
                    : '🔕 Notifications off'}
                </span>
              </div>
              </div>
              {canManage(u) && (
                <div className="staff-actions">
                  <button className="pill-btn" onClick={() => resetPassword(u)}>
                    <Icon name="key" size={16} /> Reset password
                  </button>
                  {u.id !== me.id && (
                    <button className={`pill-btn ${u.active ? 'danger' : ''}`} onClick={() => toggleActive(u)}>
                      {u.active ? 'Deactivate' : 'Activate'}
                    </button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>

        {!formOpen && (
          <button className="btn primary block" onClick={() => setFormOpen(true)}>
            <Icon name="plus" size={20} /> {isSuper ? 'Add staff' : 'Add tindera'}
          </button>
        )}
        {formOpen && (
        <form className="card form" onSubmit={add}>
          <div className="card-head">
            <h2>{isSuper ? 'Add staff' : 'Add tindera'}</h2>
            <button type="button" className="icon-btn subtle" aria-label="Close" onClick={() => setFormOpen(false)}>
              <Icon name="close" size={18} />
            </button>
          </div>
          {isSuper && (
            <div className="chips">
              <button type="button" className={`chip ${role === 'tindera' ? 'active' : ''}`} onClick={() => setRole('tindera')}>
                Tindera
              </button>
              <button type="button" className={`chip ${role === 'owner' ? 'active' : ''}`} onClick={() => setRole('owner')}>
                Owner
              </button>
            </div>
          )}
          <label className="field">
            <span className="label">Name</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Maria" required />
          </label>
          <label className="field">
            <span className="label">Username</span>
            <input
              className="input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="e.g. maria"
              autoCapitalize="none"
              autoCorrect="off"
              autoComplete="off"
              required
            />
          </label>
          <label className="field">
            <span className="label">Password (at least 6 characters)</span>
            <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required />
          </label>
          {error && <div className="error">{error}</div>}
          <button className="btn primary block" disabled={busy}>
            {busy ? 'Please wait…' : `Create ${isSuper && role === 'owner' ? 'owner' : 'tindera'} account`}
          </button>
        </form>
        )}
      </main>
    </div>
  );
}
