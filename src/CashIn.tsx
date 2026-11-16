import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, type CashinRequest, type User } from './api';
import { peso } from './format';

/** "09171234567" -> "0917 123 4567" */
const prettyNumber = (n: string) => n.replace(/^(\d{4})(\d{3})(\d{4})$/, '$1 $2 $3');

/** Keeps only digits, converts +63/63/9… to 09…, and caps at 11 digits. */
function toMobileDigits(v: string) {
  let d = v.replace(/\D/g, '');
  if (d.startsWith('63')) d = '0' + d.slice(2);
  else if (d.startsWith('9')) d = '0' + d;
  return d.slice(0, 11);
}

/** Groups digits as they are typed: 0917 123 4567 */
const formatMobile = (d: string) => [d.slice(0, 4), d.slice(4, 7), d.slice(7, 11)].filter(Boolean).join(' ');

function mobileStatus(d: string): { ok: boolean; text: string } | null {
  if (!d) return null;
  if (!d.startsWith('09')) return { ok: false, text: 'Must start with 09' };
  if (d.length < 11) {
    const left = 11 - d.length;
    return { ok: false, text: `${left} more digit${left === 1 ? '' : 's'} needed (${d.length}/11)` };
  }
  return { ok: true, text: 'Valid 11-digit mobile number' };
}

function timeAgo(iso: string) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr${hrs === 1 ? '' : 's'} ago`;
  return new Date(iso).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for older browsers / non-secure contexts.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

/** Shows a GCash-style masked name with the hidden letters (*) dimmed, so the visible letters stand out. */
export function MaskedName({ name }: { name: string }) {
  return (
    <span className="masked-name">
      {[...name.toUpperCase()].map((ch, i) =>
        ch === '*' ? (
          <span key={i} className="mask-char">
            *
          </span>
        ) : (
          ch
        ),
      )}
    </span>
  );
}

/**
 * Cash-in requests.
 * Tindera: sends the customer's mobile number + GCash name (+ amount).
 * Owner: copies the number with one tap, sends the money in GCash, then marks it done.
 */
export function CashIn({
  user,
  businessId,
  onPendingChange,
  liveStamp,
}: {
  user: User;
  /** Super admin: the business being viewed; null otherwise. */
  businessId: number | null;
  onPendingChange: (n: number) => void;
  /** Changes whenever a cash-in request is added or handled (realtime). */
  liveStamp: string | null;
}) {
  const isManager = user.role !== 'tindera';
  const canCreate = user.role !== 'superadmin';
  const [items, setItems] = useState<CashinRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showDone, setShowDone] = useState(false);
  const [form, setForm] = useState({ number: '', gcashName: '', amount: '', note: '' });
  const [formError, setFormError] = useState('');
  const [sending, setSending] = useState(false);
  const [sentMsg, setSentMsg] = useState('');
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.cashin({ businessId });
      setItems(r.items);
      onPendingChange(r.pending);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [businessId, onPendingChange]);

  // Load now, and again whenever the realtime stamp says something changed.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load() only sets state after awaiting the API
    load();
  }, [load, liveStamp]);

  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const digits = toMobileDigits(form.number);
  const status = mobileStatus(digits);
  const [knownNames, setKnownNames] = useState<string[]>([]);
  const [autoFilled, setAutoFilled] = useState(false);

  // When a complete number is entered, look up names this store used before for it.
  useEffect(() => {
    if (digits.length !== 11 || !digits.startsWith('09')) {
      setKnownNames([]);
      return;
    }
    let cancelled = false;
    api
      .cashinLookup(digits, businessId)
      .then(({ names }) => {
        if (cancelled) return;
        const list = names.map((n) => n.name);
        setKnownNames(list);
        // Fill the name in if the tindera hasn't typed one yet.
        if (list.length) {
          setForm((f) => {
            if (f.gcashName.trim()) return f;
            setAutoFilled(true);
            return { ...f, gcashName: list[0] };
          });
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [digits, businessId]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError('');
    setSentMsg('');
    setSending(true);
    try {
      await api.addCashin({ ...form, number: digits, businessId });
      setSentMsg(`Sent to the owner: ${form.number} · ${form.gcashName.toUpperCase()}`);
      setForm({ number: '', gcashName: '', amount: '', note: '' });
      setAutoFilled(false);
      load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  const copy = async (r: CashinRequest) => {
    if (await copyText(r.number)) {
      setCopiedId(r.id);
      setTimeout(() => setCopiedId((c) => (c === r.id ? null : c)), 2500);
    } else {
      alert(`Copy failed. The number is ${r.number}`);
    }
  };

  const update = async (r: CashinRequest, status: 'done' | 'cancelled') => {
    if (status === 'cancelled' && !confirm(`Cancel the cash-in to ${prettyNumber(r.number)}?`)) return;
    setBusyId(r.id);
    try {
      await api.updateCashin(r.id, status);
      await load();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const pending = items.filter((r) => r.status === 'pending');
  const finished = items.filter((r) => r.status !== 'pending');

  const card = (r: CashinRequest) => (
    <li key={r.id} className={`cashin-card ${r.status}`}>
      <div className="cashin-top">
        <span className="cashin-number">{prettyNumber(r.number)}</span>
        {r.amount !== null && <span className="cashin-amount">{peso(r.amount)}</span>}
      </div>
      <MaskedName name={r.gcashName} />
      {r.note && <div className="row-sub">{r.note}</div>}
      <div className="row-sub">
        {isManager ? `From ${r.createdByName} · ` : ''}
        {timeAgo(r.createdAt)}
        {r.status !== 'pending' &&
          ` · ${r.status === 'done' ? 'Sent' : 'Cancelled'}${r.handledByName ? ` by ${r.handledByName}` : ''}${r.handledAt ? ` ${timeAgo(r.handledAt)}` : ''}`}
      </div>
      {r.status === 'pending' && (
        <div className="cashin-actions">
          <button className={`btn primary copy-btn ${copiedId === r.id ? 'copied' : ''}`} onClick={() => copy(r)}>
            {copiedId === r.id ? '✓ Copied' : '📋 Copy number'}
          </button>
          {isManager && (
            <button className="btn done-btn" onClick={() => update(r, 'done')} disabled={busyId === r.id}>
              ✓ Done
            </button>
          )}
          {(isManager || r.createdBy === user.id) && (
            <button className="link danger-text" onClick={() => update(r, 'cancelled')} disabled={busyId === r.id}>
              Cancel
            </button>
          )}
        </div>
      )}
      {r.status !== 'pending' && <span className={`status-pill ${r.status}`}>{r.status === 'done' ? 'Sent ✓' : 'Cancelled'}</span>}
    </li>
  );

  return (
    <>
      {canCreate && (
        <form className="card form" onSubmit={submit}>
          <h2>New cash-in request</h2>
          <label className="field">
            <span className="label">Customer's GCash number</span>
            <input
              className={`input number-input ${status ? (status.ok ? 'valid' : 'invalid') : ''}`}
              type="tel"
              inputMode="numeric"
              placeholder="0917 123 4567"
              value={form.number}
              maxLength={13}
              autoComplete="off"
              name="customer-gcash-number"
              onChange={(e) => {
                const next = formatMobile(toMobileDigits(e.target.value));
                if (autoFilled && next !== form.number) {
                  // A remembered name belongs to the old number; don't carry it over.
                  setForm((f) => ({ ...f, number: next, gcashName: '' }));
                  setAutoFilled(false);
                } else {
                  set('number', next);
                }
              }}
              aria-invalid={status ? !status.ok : undefined}
              required
            />
            {status && (
              <span className={`number-status ${status.ok ? 'ok' : 'bad'}`}>
                {status.ok ? '✓' : '✗'} {status.text}
              </span>
            )}
          </label>
          <label className="field">
            <span className="label">GCash name</span>
            <input
              className="input mono"
              placeholder="e.g. JU** DE* C."
              value={form.gcashName}
              onChange={(e) => {
                setAutoFilled(false);
                set('gcashName', e.target.value);
              }}
              autoCapitalize="characters"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              required
            />
            {autoFilled ? (
              <span className="hint known">Filled in from this customer's last transaction. Check it matches GCash.</span>
            ) : (
              <span className="hint">Type it as GCash shows it. Hidden letters can be typed as *.</span>
            )}
            {knownNames.some((n) => n !== form.gcashName) && (
              <span className="known-names">
                Used before:{' '}
                {knownNames.map((n) => (
                  <button
                    type="button"
                    key={n}
                    className={`chip mono ${n === form.gcashName ? 'active' : ''}`}
                    onClick={() => {
                      set('gcashName', n);
                      setAutoFilled(true);
                    }}
                  >
                    {n.toUpperCase()}
                  </button>
                ))}
              </span>
            )}
          </label>
          <label className="field">
            <span className="label">Amount (₱)</span>
            <input className="input" inputMode="decimal" placeholder="0.00" value={form.amount} onChange={(e) => set('amount', e.target.value)} />
          </label>
          <label className="field">
            <span className="label">Note (optional)</span>
            <input className="input" value={form.note} onChange={(e) => set('note', e.target.value)} />
          </label>
          {formError && <div className="error">{formError}</div>}
          {sentMsg && <div className="success">✓ {sentMsg}</div>}
          <button className="btn primary block" disabled={sending || !status?.ok}>
            {sending ? 'Sending…' : 'Send to owner'}
          </button>
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
      ) : (
        <>
          <h3 className="section-title">Waiting{pending.length ? ` (${pending.length})` : ''}</h3>
          {pending.length === 0 ? (
            <p className="empty small">{isManager ? 'No cash-in requests waiting.' : 'Nothing waiting.'}</p>
          ) : (
            <ul className="list">{pending.map(card)}</ul>
          )}
          {finished.length > 0 && (
            <>
              <button className="link" onClick={() => setShowDone((s) => !s)}>
                {showDone ? 'Hide' : 'Show'} finished ({finished.length})
              </button>
              {showDone && <ul className="list">{finished.map(card)}</ul>}
            </>
          )}
        </>
      )}
    </>
  );
}
