import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, type StaffUser, type User } from './api';
import { PasswordInput } from './PasswordInput';

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
  const isSuper = me.role === 'superadmin';
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
      alert(
        `${role === 'owner' && isSuper ? 'Owner' : 'Tindera'} account created.\n\nUsername: ${username.trim().toLowerCase()}\nPassword: ${password}\n\nGive these to ${name}.`,
      );
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
    const pw = prompt(`New password for ${u.name} (at least 6 characters):`);
    if (!pw) return;
    try {
      await api.updateUser(u.id, { password: pw });
      alert(`Password changed for ${u.name}.${u.id !== me.id ? ' They have been logged out on all devices.' : ''}`);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  const toggleActive = async (u: StaffUser) => {
    if (u.active && !confirm(`Deactivate ${u.name}? They will be logged out and can't log in until activated again. Their transactions are kept.`)) return;
    try {
      await api.updateUser(u.id, { active: !u.active });
      load();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="page">
      <header className="appbar">
        <button className="icon-btn" aria-label="Back" onClick={onBack}>
          ←
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
              <div className="row-main">
                <span className="row-title">
                  {u.name} {u.role === 'owner' && <span className="badge">Owner</span>}
                  {!u.active && <span className="badge muted-badge">Deactivated</span>}
                </span>
                <span className="row-sub">
                  @{u.username} · {u.txnCount} transaction{u.txnCount === 1 ? '' : 's'}
                </span>
              </div>
              {canManage(u) && (
                <div className="staff-actions">
                  <button className="link" onClick={() => resetPassword(u)}>
                    Reset password
                  </button>
                  {u.id !== me.id && (
                    <button className={`link ${u.active ? 'danger-text' : ''}`} onClick={() => toggleActive(u)}>
                      {u.active ? 'Deactivate' : 'Activate'}
                    </button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>

        <form className="card form" onSubmit={add}>
          <h2>{isSuper ? 'Add staff' : 'Add tindera'}</h2>
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
      </main>
    </div>
  );
}
