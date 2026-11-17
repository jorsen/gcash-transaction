import { useEffect, useState } from 'react';
import { api, blobToPayload, KIND_INFO, type CashinRequest, type User } from './api';
import { BlobImage } from './BlobImage';
import { MaskedName } from './CashIn';
import { peso } from './format';
import { compressForStorage } from './image';
import { recognizePasses } from './ocr';
import { formatDateTime, parseGcashPasses, parseGcashReceipt, type ParsedReceipt, type TxnType } from './parseGcash';
import { markLocalAction, playChime } from './sound';
import { Icon, SkeletonRows, useUi } from './ui';

const prettyNumber = (n: string) => n.replace(/^(\d{4})(\d{3})(\d{4})$/, '$1 $2 $3');
const letters = (s: string) => s.toUpperCase().replace(/[^A-Z]/g, '');

/**
 * How well a waiting request matches what was read from the GCash receipt.
 * Amount is the strongest signal; the last 4 digits of the number and the visible letters of
 * the (masked) name break ties.
 */
function matchScore(r: CashinRequest, p: ParsedReceipt | null) {
  if (!p) return 0;
  let score = 0;
  // The owner is usually attaching the receipt for the one they're processing right now.
  if (r.status === 'processing') score += 2;
  if (p.amount !== null && r.amount !== null && Math.abs(p.amount - r.amount) < 0.005) score += 5;
  const phone = p.phone.replace(/\D/g, '');
  if (phone.length >= 4 && r.number.endsWith(phone.slice(-4))) score += 3;
  const a = letters(p.recipient);
  const b = letters(r.gcashName);
  if (a.length >= 2 && b.length >= 2) {
    if (a.slice(0, 2) === b.slice(0, 2)) score += 2;
    if (a.slice(-1) === b.slice(-1)) score += 1;
  }
  return score;
}

/**
 * Owner flow after sending/receiving money in GCash: the GCash receipt (shared from the GCash app
 * via "Share via → GCash Tracker", or picked from the gallery) is read, matched to a waiting
 * cash-in / cash-out request, saved as a receipt and attached to that request, which is marked done.
 */
export function AttachReceipt({
  user,
  businessId,
  file,
  requestId,
  onDone,
}: {
  user: User;
  /** Super admin: the business being viewed; null otherwise. */
  businessId: number | null;
  file: Blob;
  /** Preselected request (when started from a request's "Attach receipt" button). */
  requestId?: number;
  onDone: () => void;
}) {
  const ui = useUi();
  const [parsed, setParsed] = useState<ParsedReceipt | null>(null);
  const [rawText, setRawText] = useState('');
  const [reading, setReading] = useState(true);
  const [progress, setProgress] = useState('');
  const [requests, setRequests] = useState<CashinRequest[] | null>(null);
  const [selected, setSelected] = useState<number | null>(requestId ?? null);
  const [touched, setTouched] = useState(requestId !== undefined);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api
      .cashin({ businessId, pendingOnly: true })
      .then((r) => setRequests(r.items.filter((x) => x.status === 'pending' || x.status === 'processing')))
      .catch((e) => {
        setRequests([]);
        ui.toast(e instanceof Error ? e.message : String(e), 'error');
      });
    recognizePasses(file, setProgress, { enhance: true, plainPass: true })
      .then((passes) => {
        const texts = passes.reverse();
        const text = texts.join('\n');
        setRawText(text);
        setParsed(parseGcashPasses(texts));
      })
      .catch(() => setParsed(null))
      .finally(() => setReading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Best match first; preselect it unless the owner already chose one.
  const ranked = (requests ?? [])
    .map((r) => ({ r, score: matchScore(r, parsed) }))
    .sort((a, b) => b.score - a.score || +new Date(b.r.createdAt) - +new Date(a.r.createdAt));
  const best = ranked[0]?.score ? ranked[0].r.id : null;
  const chosenId = touched ? selected : (selected ?? best);
  const chosen = requests?.find((r) => r.id === chosenId) ?? null;

  const save = async (attach: boolean) => {
    const req = attach ? chosen : null;
    let amount = parsed?.amount ?? req?.amount ?? null;
    if (amount === null) {
      const v = await ui.ask({ title: 'Amount', message: "Couldn't read the amount from the receipt.", fields: [{ name: 'amount', label: 'Amount (₱)' }], confirmText: 'Save' });
      if (!v) return;
      amount = Number(v.amount.replace(/,/g, ''));
      if (!Number.isFinite(amount) || amount <= 0) {
        ui.toast('Please enter a valid amount', 'error');
        return;
      }
    }
    setSaving(true);
    try {
      markLocalAction();
      const small = await compressForStorage(file).catch(() => file);
      // The request decides the type (so totals stay right even if the receipt text reads differently).
      const type: TxnType = req
        ? req.kind === 'cashin'
          ? 'Cash In'
          : req.kind === 'payment'
            ? 'Payment'
            : parsed?.type === 'Cash Out'
              ? 'Cash Out'
              : 'Received'
        : parsed && parsed.type !== 'Other'
          ? parsed.type
          : 'Cash In';
      const { id: txnId } = await api.addTransaction({
        type,
        amount,
        refNo: parsed?.refNo ?? '',
        recipient: parsed?.recipient || req?.gcashName || '',
        phone: parsed?.phone || req?.number || '',
        txnDate: parsed?.txnDate || formatDateTime(new Date()),
        note: req ? `${KIND_INFO[req.kind].label} request from ${req.createdByName}${req.note ? ` · ${req.note}` : ''}` : '',
        rawText,
        image: await blobToPayload(small),
        ...(businessId ? { businessId } : {}),
      });
      if (req) {
        await api.updateCashin(req.id, 'done', txnId);
        playChime('done', false);
        ui.toast(`${req.kind === 'cashin' ? 'Cash-in sent' : `${KIND_INFO[req.kind].label} received`} · receipt attached`);
      } else {
        ui.toast('Receipt saved');
      }
      onDone();
    } catch (e) {
      ui.toast(`Could not save: ${e instanceof Error ? e.message : String(e)}`, 'error');
      setSaving(false);
    }
  };

  const doneLabel = chosen && chosen.kind !== 'cashin' ? 'Attach & mark received' : 'Attach & mark sent';

  return (
    <div className="page has-sticky-actions">
      <header className="appbar">
        <button className="icon-btn" aria-label="Back" onClick={onDone}>
          <Icon name="back" />
        </button>
        <div className="appbar-title">
          <h1>Attach GCash receipt</h1>
          <small>{user.businessName ?? 'Match it to a request'}</small>
        </div>
        <span className="icon-btn" />
      </header>

      <main className="content">
        <div className="attach-top">
          <div className="attach-thumb">
            <BlobImage blob={file} alt="Shared GCash receipt" />
          </div>
          <div className="attach-read">
            {reading ? (
              <div className="notice">
                <span className="spinner" /> {progress || 'Reading receipt…'}
              </div>
            ) : parsed ? (
              <dl className="read-list">
                <dt>Amount</dt>
                <dd>{parsed.amount !== null ? peso(parsed.amount) : '—'}</dd>
                <dt>Name</dt>
                <dd>{parsed.recipient ? <MaskedName name={parsed.recipient} className="" /> : '—'}</dd>
                <dt>Number</dt>
                <dd>{parsed.phone || '—'}</dd>
                <dt>Ref</dt>
                <dd>{parsed.refNo || '—'}</dd>
              </dl>
            ) : (
              <p className="muted">Couldn't read the receipt. You can still attach it.</p>
            )}
          </div>
        </div>

        <h3 className="section-title">Which request is this for?</h3>
        {requests === null ? (
          <SkeletonRows count={2} />
        ) : requests.length === 0 ? (
          <div className="empty-state compact">
            <span className="empty-icon">
              <Icon name="cash" size={32} />
            </span>
            <strong>No waiting requests</strong>
            <p>There's no cash-in or cash-out request to attach this receipt to.</p>
          </div>
        ) : (
          <ul className="list">
            {ranked.map(({ r, score }, i) => (
              <li key={r.id}>
                <button
                  className={`pick-card ${chosenId === r.id ? 'picked' : ''}`}
                  onClick={() => {
                    setTouched(true);
                    setSelected(chosenId === r.id ? null : r.id);
                  }}
                  aria-pressed={chosenId === r.id}
                >
                  <span className={`radio ${chosenId === r.id ? 'on' : ''}`} />
                  <span className="row-main">
                    <span className="pick-top">
                      <span className={`kind-badge ${r.kind}`}>{KIND_INFO[r.kind].label}</span>
                      <strong className="pick-number">{prettyNumber(r.number)}</strong>
                    </span>
                    {r.gcashName && <MaskedName name={r.gcashName} className="masked-name small" />}
                    <span className="row-sub">From {r.createdByName}</span>
                  </span>
                  <span className="pick-right">
                    {r.amount !== null && <span className="cashin-amount">{peso(r.amount)}</span>}
                    {i === 0 && score >= 5 && <span className="match-pill">Best match</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </main>

      <div className="sticky-actions">
        <button className="btn primary" onClick={() => save(true)} disabled={saving || reading || !chosen}>
          {saving ? 'Saving…' : reading ? 'Reading receipt…' : !chosen && requests?.length ? 'Pick a request above' : doneLabel}
        </button>
      </div>
    </div>
  );
}
