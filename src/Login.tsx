import { useState, type FormEvent } from 'react';
import { api, type User } from './api';
import { PasswordInput } from './PasswordInput';

/** Login screen, plus the one-time super admin setup while no super admin exists. */
export function Login({ needsSetup: setupAvailable, onLoggedIn }: { needsSetup: boolean; onLoggedIn: (u: User) => void }) {
  // Setup is offered (not forced) while no super admin exists, so existing owners/tinderas can still log in.
  const [needsSetup, setNeedsSetup] = useState(false);
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
          {needsSetup ? 'One-time setup: create the super admin account.' : 'Log in to record transactions.'}
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
          <PasswordInput
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={needsSetup ? 'new-password' : 'current-password'}
            required
          />
        </label>

        {error && <div className="error">{error}</div>}

        <button className="btn primary block" disabled={busy}>
          {busy ? 'Please wait…' : needsSetup ? 'Create super admin' : 'Log in'}
        </button>

        {setupAvailable && (
          <button type="button" className="link" onClick={() => { setNeedsSetup((v) => !v); setError(''); }}>
            {needsSetup ? '← Back to log in' : 'First-time setup (super admin)'}
          </button>
        )}
      </form>
    </div>
  );
}
