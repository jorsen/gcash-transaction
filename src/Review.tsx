import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { api, blobToPayload, imageUrl, type TxnPayload, type User } from './api';
import { BlobImage } from './BlobImage';
import { peso, prettyDate } from './format';
import { markLocalAction } from './sound';
import { Icon, Lightbox, useUi } from './ui';
import { compressForStorage } from './image';
import { recognizePasses } from './ocr';
import { formatDateTime, parseGcashPasses, parseGcashReceipt, TXN_TYPES, type TxnType } from './parseGcash';

type Form = {
  type: TxnType;
  amount: string;
  refNo: string;
  txnDate: string;
  recipient: string;
  phone: string;
  note: string;
};

/** datetime-local inputs use "YYYY-MM-DDTHH:mm"; we store "YYYY-MM-DD HH:mm". */
const toInput = (s: string) => s.replace(' ', 'T');
const fromInput = (s: string) => s.replace('T', ' ').slice(0, 16); // drop seconds if the browser adds them

const emptyForm = (): Form => ({
  type: 'Cash In',
  amount: '',
  refNo: '',
  txnDate: formatDateTime(new Date()),
  recipient: '',
  phone: '',
  note: '',
});

export function Review({
  user,
  businessId,
  file,
  id,
  onDone,
}: {
  user: User;
  /** Super admin: the business being viewed. null for owners/tinderas (their own business). */
  businessId: number | null;
  file?: File;
  id?: number;
  onDone: () => void;
}) {
  const ui = useUi();
  const isOwner = user.role !== 'tindera'; // owner or super admin
  /** Newly picked image (not yet uploaded). */
  const [newImage, setNewImage] = useState<Blob | null>(file ?? null);
  /** URL of the image already stored in the cloud (when editing). */
  const [savedImageUrl, setSavedImageUrl] = useState<string | null>(null);
  const [createdByName, setCreatedByName] = useState('');
  // The cash-in / cash-out request this receipt completed: the name the tindera typed, so it can be compared.
  const [requested, setRequested] = useState<{ name: string; number: string; by: string } | null>(null);
  /** A tindera viewing the GCash receipt the owner attached to her request: look, don't edit. */
  const [readOnly, setReadOnly] = useState(false);
  const [rawText, setRawText] = useState('');
  const [form, setForm] = useState<Form>(emptyForm);
  const [loading, setLoading] = useState(id !== undefined);
  const [scanning, setScanning] = useState(Boolean(file));
  const [progress, setProgress] = useState('');
  const [notice, setNotice] = useState('');
  const [showRaw, setShowRaw] = useState(false);
  const [saving, setSaving] = useState(false);
  const [zoom, setZoom] = useState(false);
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);

  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }));

  /** Runs OCR and fills the form. Callers set `scanning` first. */
  const runScan = async (img: Blob) => {
    try {
      // Original + enhanced readings (clean screenshots and dark-mode / blurry ones both read well).
      const texts = (await recognizePasses(img, setProgress, { enhance: true, plainPass: true })).reverse();
      const text = texts.join('\n');
      setRawText(text);
      const p = parseGcashPasses(texts);
      setForm((f) => ({
        ...f,
        type: p.type === 'Other' ? f.type : p.type,
        amount: p.amount !== null ? p.amount.toFixed(2) : f.amount,
        refNo: p.refNo || f.refNo,
        txnDate: p.txnDate || f.txnDate,
        recipient: p.recipient || f.recipient,
        phone: p.phone || f.phone,
      }));
      const missing = [p.amount === null && 'amount', !p.refNo && 'reference no.', !p.txnDate && 'date'].filter(Boolean);
      setNotice(
        missing.length
          ? `Couldn't find: ${missing.join(', ')}. Please fill in or check below.`
          : 'Details read from the receipt. Please double-check before saving.',
      );
    } catch (e) {
      setNotice(
        `Could not read the receipt (${e instanceof Error ? e.message : String(e)}). ` +
          'You can still enter the details manually and save.',
      );
    } finally {
      setScanning(false);
    }
  };

  const scan = (img: Blob) => {
    setScanning(true);
    setProgress('');
    setNotice('');
    runScan(img);
  };

  useEffect(() => {
    if (file) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- runScan only sets state after awaiting OCR
      runScan(file);
    } else if (id !== undefined) {
      api
        .transaction(id)
        .then(({ txn: t }) => {
          setSavedImageUrl(t.hasImage ? imageUrl(t) : null);
          setRawText(t.rawText ?? '');
          setCreatedByName(t.createdByName);
          setRequested(t.requestedName || t.requestedNumber ? { name: t.requestedName, number: t.requestedNumber, by: t.requestedByName } : null);
          setReadOnly(true); // saved transactions are view only (no editing)
          setForm({
            type: t.type,
            amount: t.amount.toFixed(2),
            refNo: t.refNo,
            txnDate: t.txnDate,
            recipient: t.recipient,
            phone: t.phone,
            note: t.note,
          });
        })
        .catch((e) => setNotice(e instanceof Error ? e.message : String(e)))
        .finally(() => setLoading(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    setNewImage(f);
    scan(f);
  };

  const doSave = async () => {
    setSaving(true);
    try {
      const payload: TxnPayload = {
        type: form.type,
        amount: parseFloat(form.amount.replace(/,/g, '')),
        refNo: form.refNo.replace(/\s+/g, ''),
        recipient: form.recipient.trim(),
        phone: form.phone.trim(),
        txnDate: form.txnDate.trim(),
        note: form.note.trim(),
        rawText,
      };
      if (newImage) {
        // Shrink to ~150 KB before uploading; if that fails, upload the original.
        const small = await compressForStorage(newImage).catch(() => newImage);
        payload.image = await blobToPayload(small);
      } else if (id === undefined) {
        payload.image = null;
      }
      if (businessId) payload.businessId = businessId;
      markLocalAction();
      if (id !== undefined) await api.updateTransaction(id, payload);
      else await api.addTransaction(payload);
      ui.toast(id !== undefined ? 'Changes saved' : `Saved ${peso(payload.amount)} ${payload.type}`);
      onDone();
    } catch (e) {
      ui.toast(`Could not save: ${e instanceof Error ? e.message : String(e)}`, 'error');
      setSaving(false);
    }
  };

  const save = async () => {
    const amount = parseFloat(form.amount.replace(/,/g, ''));
    if (!Number.isFinite(amount) || amount <= 0) {
      ui.toast('Please enter a valid amount', 'error');
      document.querySelector<HTMLInputElement>('input[inputmode="decimal"]')?.focus();
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(form.txnDate.trim())) {
      ui.toast('Please enter the date and time', 'error');
      return;
    }
    const ref = form.refNo.replace(/\s+/g, '');
    if (ref) {
      try {
        const { duplicate: d } = await api.checkRef(ref, id, businessId);
        if (
          d &&
          !(await ui.confirm({
            title: 'Already recorded?',
            message: `Ref ${d.refNo} was saved by ${d.createdByName} on ${prettyDate(d.txnDate)} (${d.recipient || d.type}).`,
            confirmText: 'Save anyway',
            cancelText: 'Go back',
          }))
        ) {
          return;
        }
      } catch {
        // If the check fails (e.g. offline), let the save itself report the problem.
      }
    }
    doSave();
  };

  const remove = async () => {
    if (
      id === undefined ||
      !(await ui.confirm({ title: 'Delete this transaction?', message: 'Its receipt image is deleted too. This cannot be undone.', confirmText: 'Delete', danger: true }))
    )
      return;
    try {
      markLocalAction();
      await api.deleteTransaction(id);
      ui.toast('Transaction deleted', 'info');
      onDone();
    } catch (e) {
      ui.toast(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  const hasImage = Boolean(newImage || savedImageUrl);
  const imageEl = newImage ? (
    <BlobImage blob={newImage} alt="Receipt" />
  ) : (
    <img src={savedImageUrl ?? ''} alt="Receipt" />
  );

  return (
    <div className="page has-sticky-actions">
      <header className="appbar">
        <button className="icon-btn" aria-label="Back" onClick={onDone}>
          <Icon name="back" />
        </button>
        <div className="appbar-title">
          <h1>{id !== undefined ? 'Transaction' : 'New receipt'}</h1>
          {isOwner && createdByName && (
            <small>{requested?.by ? `Tindera: ${requested.by}${requested.by !== createdByName ? ` · saved by ${createdByName}` : ''}` : `Saved by ${createdByName}`}</small>
          )}
        </div>
        {id !== undefined && isOwner ? (
          <button className="icon-btn" aria-label="Delete transaction" onClick={remove}>
            <Icon name="trash" />
          </button>
        ) : (
          <span className="icon-btn" />
        )}
      </header>

      <main className={`content ${readOnly ? 'read-only' : ''}`}>
        {readOnly && user.role === 'tindera' && <div className="notice">GCash receipt attached by {createdByName} for your request (view only).</div>}
        {loading ? (
          <div className="center">
            <span className="spinner big" />
          </div>
        ) : (
          <>
            {hasImage ? (
              <button className="receipt" onClick={() => setZoom(true)} aria-label="View full receipt">
                {imageEl}
              </button>
            ) : (
              <div className="receipt receipt-empty">No receipt image</div>
            )}

            <div className="image-actions">
              <button className="pill-btn" onClick={() => cameraRef.current?.click()}>
                <Icon name="camera" size={18} /> Retake
              </button>
              <button className="pill-btn" onClick={() => galleryRef.current?.click()}>
                <Icon name="image" size={18} /> Choose another
              </button>
              {newImage && (
                <button className="pill-btn" onClick={() => scan(newImage)} disabled={scanning}>
                  <Icon name="search" size={18} /> Re-scan
                </button>
              )}
            </div>
            <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={onPick} />
            <input ref={galleryRef} type="file" accept="image/*" hidden onChange={onPick} />

            {scanning ? (
              <div className="notice">
                <span className="spinner" /> {progress || 'Reading receipt…'}
              </div>
            ) : (
              notice && <div className="notice">{notice}</div>
            )}

            <span className="label">Type</span>
            <div className="chips scroll">
              {TXN_TYPES.map((t) => (
                <button key={t} className={`chip ${form.type === t ? 'active' : ''}`} onClick={() => set('type', t)}>
                  {t}
                </button>
              ))}
            </div>

            <Field label="Amount (₱)">
              <input className="input amount-input" inputMode="decimal" placeholder="0.00" value={form.amount} onChange={(e) => set('amount', e.target.value)} />
            </Field>
            <Field label="Reference No.">
              <input className="input" inputMode="numeric" placeholder="13-digit ref no." value={form.refNo} onChange={(e) => set('refNo', e.target.value)} />
            </Field>
            <Field label="Date & time">
              <input className="input" type="datetime-local" value={toInput(form.txnDate)} onChange={(e) => set('txnDate', fromInput(e.target.value))} />
            </Field>
            <Field label="Name / Merchant">
              <input className="input" placeholder="e.g. JU•• DE•A C." value={form.recipient} onChange={(e) => set('recipient', e.target.value)} />
            </Field>
            <Field label="Mobile number">
              <input className="input" type="tel" placeholder="+63 9XX XXX XXXX" value={form.phone} onChange={(e) => set('phone', e.target.value)} />
            </Field>
            <Field label="Note">
              <textarea className="input" rows={3} placeholder="What was this for?" value={form.note} onChange={(e) => set('note', e.target.value)} />
            </Field>

            {rawText && (
              <button className="link" onClick={() => setShowRaw((s) => !s)}>
                {showRaw ? 'Hide' : 'Show'} scanned text
              </button>
            )}
            {showRaw && <pre className="raw">{rawText}</pre>}
          </>
        )}
      </main>

      {!loading && readOnly && (
        <div className="sticky-actions">
          <button className="btn primary" onClick={onDone}>
            Close
          </button>
        </div>
      )}
      {!loading && !readOnly && (
        <div className="sticky-actions">
          <button className="btn secondary" onClick={onDone} disabled={saving}>
            Cancel
          </button>
          <button className="btn primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : id !== undefined ? 'Save changes' : 'Save receipt'}
          </button>
        </div>
      )}

      {zoom && hasImage && <Lightbox onClose={() => setZoom(false)}>{imageEl}</Lightbox>}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="label">{label}</span>
      {children}
    </label>
  );
}
