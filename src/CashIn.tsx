import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api, blobToPayload, proofUrl, type CashinRequest, type RequestKind, type User } from './api';
import { BlobImage } from './BlobImage';
import { CropSheet } from './CropSheet';
import { compressForStorage, type CropBox } from './image';
import { recognizeText } from './ocr';
import { looksLikeBankTransfer, parseBankTransfer } from './parseBank';
import { parseGcashReceipt } from './parseGcash';
import { peso } from './format';
import { markLocalAction } from './sound';
import { Icon, SkeletonRows, useUi } from './ui';

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

const isAndroid = () => /android/i.test(navigator.userAgent);
const isPhone = () => /android|iphone|ipad|ipod/i.test(navigator.userAgent);

/** GCash's Android package (Play Store: com.globe.gcash.android). */
const GCASH_PACKAGE = 'com.globe.gcash.android';

/**
 * Link that opens the GCash app's home screen.
 * - Android: Chrome "intent:" link that launches the installed app by package, like tapping its icon
 *   (a bare gcash:// doesn't match GCash's deep-link filter, so nothing opens). Not installed → Play Store.
 * - iPhone: GCash's gcash:// scheme.
 */
export const gcashAppLink = () =>
  isAndroid()
    ? `intent:#Intent;action=android.intent.action.MAIN;category=android.intent.category.LAUNCHER;package=${GCASH_PACKAGE};S.browser_fallback_url=${encodeURIComponent(`https://play.google.com/store/apps/details?id=${GCASH_PACKAGE}`)};end`
    : 'gcash://';

/**
 * Opens the GCash app so the owner can paste the copied number. Phones only.
 * Must run right after the tap (browsers only let a page open another app during a user gesture),
 * so call it before any network request. Calls onFail if the app didn't open (page still visible after 2.5 s).
 */
function openGcashApp(onFail: () => void) {
  if (!isPhone()) return false;
  let left = false;
  const onHide = () => {
    if (document.visibilityState === 'hidden') left = true;
  };
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', onHide);
  setTimeout(() => {
    document.removeEventListener('visibilitychange', onHide);
    window.removeEventListener('pagehide', onHide);
    if (!left && document.visibilityState === 'visible') onFail();
  }, 2500);
  window.location.href = gcashAppLink();
  return true;
}

/** Shows a GCash-style masked name with the hidden letters (• or *) dimmed, so the visible letters stand out. */
export function MaskedName({ name, className = 'masked-name' }: { name: string; className?: string }) {
  return (
    <span className={className}>
      {[...name].map((ch, i) =>
        ch === '*' || ch === '•' ? (
          <span key={i} className="mask-char">
            •
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
  onAttach,
  onViewReceipt,
}: {
  user: User;
  /** Super admin: the business being viewed; null otherwise. */
  businessId: number | null;
  onPendingChange: (n: number) => void;
  /** Changes whenever a cash-in request is added or handled (realtime). */
  liveStamp: string | null;
  /** Owner: attach a GCash receipt image to a request (opens the attach screen). */
  onAttach: (file: Blob, requestId: number) => void;
  /** Open the GCash receipt attached to a finished request. */
  onViewReceipt: (txnId: number) => void;
}) {
  const ui = useUi();
  const isManager = user.role !== 'tindera';
  const canCreate = user.role !== 'superadmin';
  // Tinderas mainly create requests; owners mainly handle them, so their form starts collapsed.
  const [formOpen, setFormOpen] = useState(!isManager);
  const [view, setView] = useState<'waiting' | 'finished'>('waiting');
  const [items, setItems] = useState<CashinRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ number: '', gcashName: '', amount: '', note: '' });
  const [kind, setKind] = useState<RequestKind>('cashin');
  // Cash-out: where the customer sends from, bank details, and a photo of their receipt as proof.
  const [source, setSource] = useState<'gcash' | 'bank'>('gcash');
  const [bank, setBank] = useState({ bankName: '', accountLast4: '', refNo: '' });
  const [proof, setProof] = useState<Blob | null>(null);
  const [cropFile, setCropFile] = useState<Blob | null>(null);
  const [scanMsg, setScanMsg] = useState('');
  const [scanning, setScanning] = useState(false);
  const [proofView, setProofView] = useState<number | null>(null);
  const scanInput = useRef<HTMLInputElement>(null);
  const isBank = kind === 'cashout' && source === 'bank';
  const setBankField = (k: keyof typeof bank, v: string) => setBank((b) => ({ ...b, [k]: v }));

  /** Read the customer's receipt photo (only the framed part), and fill in what we can. */
  const scanProof = async (file: Blob, crop?: CropBox) => {
    setCropFile(null);
    setProof(file);
    setScanning(true);
    setScanMsg('Reading receipt…');
    try {
      const text = await recognizeText(file, (p) => setScanMsg(p), { crop, enhance: true, multiPass: true });
      if (looksLikeBankTransfer(text)) {
        const p = parseBankTransfer(text);
        setSource('bank');
        setBank((b) => ({
          bankName: p.from.bank || b.bankName,
          accountLast4: p.from.last4 || b.accountLast4,
          refNo: p.refNo || b.refNo,
        }));
        setForm((f) => ({
          ...f,
          gcashName: p.from.name ? p.from.name.toUpperCase() : f.gcashName,
          amount: p.amount !== null ? p.amount.toFixed(2) : f.amount,
        }));
        const got = [
          p.amount !== null && 'amount',
          p.from.name && 'sender',
          p.from.bank && 'bank',
          p.from.last4 && 'account',
          p.refNo && 'reference no.',
        ].filter(Boolean);
        setScanMsg(got.length ? `${p.channel || 'Bank transfer'} · read ${got.join(', ')}. Check every field before sending.` : "Couldn't read it. Type the details below.");
      } else {
        const p = parseGcashReceipt(text);
        setForm((f) => ({ ...f, amount: p.amount !== null ? p.amount.toFixed(2) : f.amount }));
        if (p.refNo) setBankField('refNo', p.refNo);
        setScanMsg(p.amount !== null ? 'Read the amount. Check the details before sending.' : "Couldn't read it. Type the details below.");
      }
    } catch (e) {
      setScanMsg(`Couldn't read the receipt (${e instanceof Error ? e.message : String(e)}). Type the details below.`);
    } finally {
      setScanning(false);
    }
  };
  const attachInput = useRef<HTMLInputElement>(null);
  const attachFor = useRef<number | null>(null);
  const [formError, setFormError] = useState('');
  const [sending, setSending] = useState(false);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [remindCooldown, setRemindCooldown] = useState<Record<number, boolean>>({});

  /** Tindera: alert the owner again ("Pa cash in po!"). Can be pressed repeatedly (3 s apart). */
  const remind = async (r: CashinRequest) => {
    setRemindCooldown((c) => ({ ...c, [r.id]: true }));
    setTimeout(() => setRemindCooldown((c) => ({ ...c, [r.id]: false })), 3000);
    try {
      markLocalAction();
      const { remindCount } = await api.remindCashin(r.id);
      setItems((list) => list.map((x) => (x.id === r.id ? { ...x, remindCount } : x)));
      ui.toast(`Owner reminded (${remindCount}×)`);
    } catch (err) {
      ui.toast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

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
    setSending(true);
    try {
      markLocalAction();
      const proofPayload = kind === 'cashout' && proof ? await blobToPayload(await compressForStorage(proof).catch(() => proof)) : null;
      await api.addCashin({
        ...form,
        number: digits,
        businessId,
        kind,
        source: kind === 'cashout' ? source : 'gcash',
        bankName: isBank ? bank.bankName : '',
        accountLast4: isBank ? bank.accountLast4 : '',
        refNo: kind === 'cashout' ? bank.refNo : '',
        proof: proofPayload,
      });
      ui.toast(isBank ? `Sent to the owner: ${bank.bankName} cash-out` : `Sent to the owner: ${form.number}`);
      setForm({ number: '', gcashName: '', amount: '', note: '' });
      setBank({ bankName: '', accountLast4: '', refNo: '' });
      setProof(null);
      setScanMsg('');
      setSource('gcash');
      setAutoFilled(false);
      load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  const isOpen = (r: CashinRequest) => r.status === 'pending' || r.status === 'processing';

  const copy = async (r: CashinRequest) => {
    if (!(await copyText(r.number))) {
      ui.info({ title: 'Copy failed', message: `The number is ${prettyNumber(r.number)}` });
      return;
    }
    setCopiedId(r.id);
    setTimeout(() => setCopiedId((c) => (c === r.id ? null : c)), 2500);
    const ownerSending = isManager && r.kind === 'cashin';
    // 1) Open GCash immediately, while the tap still counts as a user gesture.
    const opening =
      ownerSending &&
      openGcashApp(() => ui.toast("GCash didn't open. Tap \"Open GCash\" on the card, then paste the number.", 'info'));
    ui.toast(opening ? `${prettyNumber(r.number)} copied · opening GCash…` : `${prettyNumber(r.number)} copied. Paste it in GCash.`);
    // 2) Mark it Processing (yellow) in the background. keepalive lets it finish even though we just
    //    switched to GCash, so the tindera still sees it right away.
    if (ownerSending && r.status === 'pending') {
      markLocalAction();
      api
        .updateCashin(r.id, 'processing', undefined, { keepalive: true })
        .then(() => load())
        .catch((err) => ui.toast(err instanceof Error ? err.message : String(err), 'error'));
    }
  };

  /** Process = upload the GCash receipt; the attach screen marks the request Sent. */
  const processReceipt = (r: CashinRequest) => {
    attachFor.current = r.id;
    attachInput.current?.click();
  };

  const update = async (r: CashinRequest, status: 'done' | 'cancelled') => {
    if (
      status === 'cancelled' &&
      !(await ui.confirm({
        title: `Cancel this ${r.kind === 'cashout' ? 'cash-out' : 'cash-in'}?`,
        message: `${prettyNumber(r.number)}${r.gcashName ? ` · ${r.gcashName.toUpperCase()}` : ''}${r.amount !== null ? ` · ${peso(r.amount)}` : ''}`,
        confirmText: 'Cancel request',
        cancelText: 'Keep',
        danger: true,
      }))
    )
      return;
    setBusyId(r.id);
    try {
      markLocalAction();
      await api.updateCashin(r.id, status);
      ui.toast(status === 'done' ? (r.kind === 'cashout' ? 'Marked as received' : 'Marked as sent') : 'Request cancelled', status === 'done' ? 'success' : 'info');
      await load();
    } catch (err) {
      ui.toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const pending = items.filter(isOpen);
  const finished = items.filter((r) => !isOpen(r));

  const doneWord = (r: CashinRequest) => (r.kind === 'cashout' ? 'Received' : 'Sent');
  const statusLabel = (r: CashinRequest) =>
    r.status === 'pending' ? 'Waiting' : r.status === 'processing' ? 'Processing' : r.status === 'done' ? doneWord(r) : 'Cancelled';

  const card = (r: CashinRequest) => (
    <li key={r.id} className={`cashin-card ${r.status} kind-${r.kind}`}>
      <span className={`kind-badge ${r.kind}`}>{r.kind === 'cashout' ? 'Cash out' : 'Cash in'}</span>
      <span className={`status-pill ${r.status}`}>{statusLabel(r)}</span>
      <div className="cashin-top">
        {r.source === 'bank' ? (
          <span className="cashin-number bank">
            🏦 {r.bankName || 'Bank'}
            {r.accountLast4 ? <small> ••{r.accountLast4}</small> : null}
          </span>
        ) : (
          <span className="cashin-number">{prettyNumber(r.number)}</span>
        )}
        {r.amount !== null && <span className="cashin-amount">{peso(r.amount)}</span>}
      </div>
      {r.gcashName && <MaskedName name={r.gcashName} />}
      {(r.source === 'bank' || r.refNo) && (
        <div className="row-sub">
          {r.source === 'bank' ? 'InstaPay / bank transfer to GCash' : 'GCash'}
          {r.refNo ? ` · Ref ${r.refNo}` : ''}
        </div>
      )}
      {r.hasProof && (
        <button className="pill-btn proof-btn" onClick={() => setProofView(r.id)}>
          <Icon name="image" size={16} /> View customer's receipt
        </button>
      )}
      {r.note && <div className="row-sub">{r.note}</div>}
      {isOpen(r) && r.remindCount > 0 && (
        <span className={`remind-badge ${isManager ? 'urgent' : ''}`}>
          🔔 Reminded {r.remindCount}×{r.lastRemindedAt ? ` · last ${timeAgo(r.lastRemindedAt)}` : ''}
        </span>
      )}
      <div className="row-sub">
        {isManager ? `From ${r.createdByName} · ` : ''}
        {timeAgo(r.createdAt)}
        {r.status === 'processing' && ` · Processing${r.processingByName ? ` by ${r.processingByName}` : ''}${r.processingAt ? ` ${timeAgo(r.processingAt)}` : ''}`}
        {!isOpen(r) &&
          ` · ${r.status === 'done' ? doneWord(r) : 'Cancelled'}${r.handledByName ? ` by ${r.handledByName}` : ''}${r.handledAt ? ` ${timeAgo(r.handledAt)}` : ''}`}
      </div>
      {r.status === 'done' && r.txnId && (
        <button className="pill-btn receipt-link" onClick={() => onViewReceipt(r.txnId as number)}>
          <Icon name="receipt" size={16} /> {r.kind === 'cashout' ? 'View saved record' : 'View GCash receipt'}
        </button>
      )}

      {isOpen(r) && (
        <>
          <div className="cashin-actions">
            {/* Owner, cash-in, processing: yellow Process (upload receipt -> Sent) + copy again */}
            {isManager && r.kind === 'cashin' && r.status === 'processing' ? (
              <>
                <button className="btn secondary copy-again" onClick={() => copy(r)} aria-label={isPhone() ? 'Copy number and open GCash again' : 'Copy number again'}>
                  <Icon name={copiedId === r.id ? 'check' : 'copy'} size={18} />
                </button>
                <button className="btn process-btn" onClick={() => processReceipt(r)} disabled={busyId === r.id}>
                  <Icon name="image" size={18} /> Process
                </button>
              </>
            ) : r.source === 'bank' ? null : (
              <button className={`btn primary copy-btn ${copiedId === r.id ? 'copied' : ''}`} onClick={() => copy(r)}>
                <Icon name={copiedId === r.id ? 'check' : 'copy'} size={18} />
                {copiedId === r.id ? 'Copied' : isManager && r.kind === 'cashin' && isPhone() ? 'Copy & open GCash' : 'Copy number'}
              </button>
            )}
            {isManager && r.kind === 'cashout' && (
              <button className="btn done-btn" onClick={() => update(r, 'done')} disabled={busyId === r.id}>
                <Icon name="check" size={18} /> {doneWord(r)}
              </button>
            )}
            {(isManager || r.createdBy === user.id) && (
              <button className="link danger-text" onClick={() => update(r, 'cancelled')} disabled={busyId === r.id}>
                Cancel
              </button>
            )}
          </div>
          {isManager && r.kind === 'cashin' && r.status === 'pending' && (
            <span className="hint">Copies the number{isPhone() ? ' and opens GCash' : ''}. Paste it in GCash and send. The card turns yellow (Processing).</span>
          )}
          {isManager && r.kind === 'cashin' && r.status === 'processing' && isPhone() && (
            <a className="pill-btn open-gcash" href={gcashAppLink()}>
              <Icon name="install" size={16} /> Open GCash
            </a>
          )}
          {isManager && r.kind === 'cashin' && r.status === 'processing' && (
            <span className="hint processing-hint">Sent it in GCash? Tap Process and upload the GCash receipt. It turns green (Sent).</span>
          )}
          {!isManager && r.status === 'processing' && <span className="hint processing-hint">The owner is sending it now…</span>}
          {!isManager && r.createdBy === user.id && r.status === 'pending' && (
            <button className="btn remind-btn" onClick={() => remind(r)} disabled={remindCooldown[r.id]}>
              🔔 {r.kind === 'cashout' ? 'Pa cash out po!' : 'Pa cash in po!'}
              <small>{remindCooldown[r.id] ? 'Sent to owner' : 'Tap to remind the owner'}</small>
            </button>
          )}
          {isManager && r.kind === 'cashout' && (
            <span className="hint">
              Check that {r.amount !== null ? peso(r.amount) : 'the money'} arrived in the store's GCash
              {r.source === 'bank' ? ` from ${r.bankName || 'the bank'}` : ''}, then tap Received. It's saved as a received transaction.
            </span>
          )}
          {isManager && r.kind === 'cashout' && !r.hasProof && (
            <button className="pill-btn attach-btn" onClick={() => processReceipt(r)}>
              <Icon name="image" size={16} /> Attach GCash receipt &amp; mark {doneWord(r).toLowerCase()}
            </button>
          )}
        </>
      )}
    </li>
  );

  const formEl = canCreate && !formOpen && (
    <button className="btn secondary block new-request-btn" onClick={() => setFormOpen(true)}>
      <Icon name="plus" size={20} /> New cash-in / cash-out request
    </button>
  );

  const form_ = canCreate && formOpen && (
        <form className="card form" onSubmit={submit}>
          <div className="card-head">
            <h2>New request</h2>
            {isManager && (
              <button type="button" className="icon-btn subtle" aria-label="Close" onClick={() => setFormOpen(false)}>
                <Icon name="close" size={18} />
              </button>
            )}
          </div>
          <div className="field">
            <div className="segmented kind-toggle" role="tablist">
              <button type="button" role="tab" aria-selected={kind === 'cashin'} className={kind === 'cashin' ? 'active' : ''} onClick={() => setKind('cashin')}>
                Cash in
              </button>
              <button type="button" role="tab" aria-selected={kind === 'cashout'} className={kind === 'cashout' ? 'active' : ''} onClick={() => setKind('cashout')}>
                Cash out
              </button>
            </div>
            <span className="hint">
              {kind === 'cashin'
                ? 'Customer pays cash; the owner sends GCash to their number.'
                : 'Customer sends money to the store\'s GCash; the owner confirms, then you give the cash.'}
            </span>
          </div>
          {kind === 'cashout' && (
            <div className="field">
              <span className="label">Customer sends from</span>
              <div className="segmented" role="tablist">
                <button type="button" role="tab" aria-selected={source === 'gcash'} className={source === 'gcash' ? 'active' : ''} onClick={() => setSource('gcash')}>
                  GCash
                </button>
                <button type="button" role="tab" aria-selected={source === 'bank'} className={source === 'bank' ? 'active' : ''} onClick={() => setSource('bank')}>
                  🏦 Bank / InstaPay
                </button>
              </div>
            </div>
          )}
          {kind === 'cashout' && (
            <div className="scan-proof">
              {proof && (
                <span className="proof-thumb">
                  <BlobImage blob={proof} alt="Customer's receipt" />
                </span>
              )}
              <div className="scan-proof-main">
                <button type="button" className="btn secondary block" onClick={() => scanInput.current?.click()} disabled={scanning}>
                  <Icon name="camera" size={20} /> {proof ? 'Scan again' : "Scan customer's receipt"}
                </button>
                {scanMsg ? (
                  <span className={`hint ${scanning ? '' : 'known'}`}>
                    {scanning && <span className="spinner" />} {scanMsg}
                  </span>
                ) : (
                  <span className="hint">Take a photo of the customer's transfer receipt. It's kept as proof and fills in the details.</span>
                )}
                {proof && !scanning && (
                  <button type="button" className="link danger-text small-link" onClick={() => { setProof(null); setScanMsg(''); }}>
                    Remove photo
                  </button>
                )}
              </div>
              <input
                ref={scanInput}
                type="file"
                accept="image/*"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (f) setCropFile(f);
                }}
              />
            </div>
          )}
          {isBank && (
            <>
              <label className="field">
                <span className="label">Bank (sender)</span>
                <input
                  className="input"
                  list="ph-banks"
                  placeholder="e.g. GoTyme Bank, BDO, BPI, Maya"
                  value={bank.bankName}
                  onChange={(e) => setBankField('bankName', e.target.value)}
                  required
                />
                <datalist id="ph-banks">
                  {['GoTyme Bank', 'BDO', 'BPI', 'Metrobank', 'UnionBank', 'LandBank', 'Security Bank', 'RCBC', 'PNB', 'China Bank', 'EastWest', 'SeaBank', 'Maya', 'CIMB', 'Tonik', 'UNO Digital Bank', 'ShopeePay', 'Coins.ph'].map((b) => (
                    <option key={b} value={b} />
                  ))}
                </datalist>
              </label>
              <div className="field-row">
                <label className="field">
                  <span className="label">Account (last 4)</span>
                  <input
                    className="input"
                    inputMode="numeric"
                    maxLength={4}
                    placeholder="5340"
                    value={bank.accountLast4}
                    onChange={(e) => setBankField('accountLast4', e.target.value.replace(/\D/g, ''))}
                  />
                </label>
                <label className="field grow">
                  <span className="label">Reference No. (optional)</span>
                  <input className="input mono" placeholder="IT0261117…" value={bank.refNo} onChange={(e) => setBankField('refNo', e.target.value)} autoCapitalize="characters" />
                </label>
              </div>
            </>
          )}
          {!isBank && (
          <label className="field">
            <span className="label">{kind === 'cashin' ? "Customer's GCash number" : "Customer's GCash number (sender)"}</span>
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
          )}
          <label className="field">
            <span className="label">{isBank ? "Sender's name (as on the receipt)" : kind === 'cashin' ? 'GCash name' : 'GCash name (optional)'}</span>
            <input
              className="input mono"
              placeholder={isBank ? 'e.g. J. GARCIA' : 'e.g. JU•• DE•A C.'}
              value={form.gcashName}
              onChange={(e) => {
                setAutoFilled(false);
                set('gcashName', e.target.value);
              }}
              autoCapitalize="characters"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              required={kind === 'cashin'}
            />
            {isBank ? null : autoFilled ? (
              <span className="hint known">Filled in from this customer's last transaction. Check it matches GCash.</span>
            ) : (
              <span className="hint">Type it as GCash shows it. Type hidden letters as * (saved as • like in GCash).</span>
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
          <button
            className="btn primary block"
            disabled={sending || scanning || (isBank ? !bank.bankName.trim() || !form.amount.trim() : !status?.ok)}
          >
            {sending ? 'Sending…' : 'Send to owner'}
          </button>
        </form>
  );

  const shown = view === 'waiting' ? pending : finished;
  const listEl = error ? (
    <div className="empty-state">
      <p className="error">{error}</p>
      <button className="btn secondary" onClick={load}>
        Try again
      </button>
    </div>
  ) : loading ? (
    <SkeletonRows count={2} />
  ) : (
    <>
      <div className="segmented" role="tablist">
        <button role="tab" aria-selected={view === 'waiting'} className={view === 'waiting' ? 'active' : ''} onClick={() => setView('waiting')}>
          Waiting{pending.length ? ` · ${pending.length}` : ''}
        </button>
        <button role="tab" aria-selected={view === 'finished'} className={view === 'finished' ? 'active' : ''} onClick={() => setView('finished')}>
          Finished{finished.length ? ` · ${finished.length}` : ''}
        </button>
      </div>
      {shown.length === 0 ? (
        <div className="empty-state compact">
          <span className="empty-icon">
            <Icon name="cash" size={34} />
          </span>
          <strong>{view === 'waiting' ? 'No cash-in requests waiting' : 'Nothing finished yet'}</strong>
          {view === 'waiting' && <p>{isManager ? 'New requests from tinderas appear here instantly.' : 'Requests you send appear here until the owner sends them.'}</p>}
        </div>
      ) : (
        <ul className="list">{shown.map(card)}</ul>
      )}
    </>
  );

  const attachPicker = (
    <input
      ref={attachInput}
      type="file"
      accept="image/*"
      hidden
      onChange={(e) => {
        const f = e.target.files?.[0];
        e.target.value = '';
        if (f && attachFor.current !== null) onAttach(f, attachFor.current);
      }}
    />
  );

  const overlays = (
    <>
      {cropFile && (
        <CropSheet
          file={cropFile}
          title="Frame the customer's receipt"
          onCancel={() => setCropFile(null)}
          onDone={(crop) => scanProof(cropFile, crop)}
        />
      )}
      {proofView !== null && (
        <div className="zoom" onClick={() => setProofView(null)}>
          <img src={proofUrl(proofView)} alt="Customer's transfer receipt" />
        </div>
      )}
    </>
  );

  // Tindera: form first. Owner: waiting requests first, form behind a button.
  return isManager ? (
    <>
      {overlays}
      {attachPicker}
      {listEl}
      {formEl}
      {form_}
    </>
  ) : (
    <>
      {overlays}
      {formEl}
      {form_}
      {listEl}
    </>
  );
}
