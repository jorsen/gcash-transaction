import { useState, type FormEvent } from 'react';
import { api, type User } from './api';

/** Login screen, or the one-time owner setup when the database has no users yet. */
export function Login({ needsSetup, onLoggedIn }: { needsSetup: boolean; onLoggedIn: (u: User) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [setupCode, setSetupCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const { user } = needsSetup
        ? await api.setup({ setupCode, name, username, password })
        : await api.login(username, password);
      onLoggedIn(user);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page login-page">
      <form className="login-card" onSubmit={submit}>
        <img src="/pwa-192x192.png" alt="" className="login-logo" />
        <h1>GCash Tracker</h1>
        <p className="muted">
          {needsSetup ? 'First time setup: create the owner account.' : 'Log in to record transactions.'}
        </p>

        {needsSetup && (
          <>
            <label className="field">
              <span className="label">Setup code</span>
              <input className="input" value={setupCode} onChange={(e) => setSetupCode(e.target.value)} autoComplete="off" required />
            </label>
            <label className="field">
              <span className="label">Your name</span>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Aling Rosa" required />
            </label>
          </>
        )}
        <label className="field">
          <span className="label">Username</span>
          <input
            className="input"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="username"
            required
          />
        </label>
        <label className="field">
          <span className="label">Password</span>
          <input
            className="input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={needsSetup ? 'new-password' : 'current-password'}
            required
          />
        </label>

        {error && <div className="error">{error}</div>}

        <button className="btn primary block" disabled={busy}>
          {busy ? 'Please wait…' : needsSetup ? 'Create owner account' : 'Log in'}
        </button>
      </form>
    </div>
  );
}
