import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { api, blobToPayload, imageUrl, type TxnPayload, type User } from './api';
import { BlobImage } from './BlobImage';
import { prettyDate } from './format';
import { compressForStorage } from './image';
import { recognizeText } from './ocr';
import { formatDateTime, parseGcashReceipt, TXN_TYPES, type TxnType } from './parseGcash';

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
  type: 'Send Money',
  amount: '',
  refNo: '',
  txnDate: formatDateTime(new Date()),
  recipient: '',
  phone: '',
  note: '',
});

export function Review({ user, file, id, onDone }: { user: User; file?: File; id?: number; onDone: () => void }) {
  const isOwner = user.role === 'owner';
  /** Newly picked image (not yet uploaded). */
  const [newImage, setNewImage] = useState<Blob | null>(file ?? null);
  /** URL of the image already stored in the cloud (when editing). */
  const [savedImageUrl, setSavedImageUrl] = useState<string | null>(null);
  const [createdByName, setCreatedByName] = useState('');
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
      const text = await recognizeText(img, setProgress);
      setRawText(text);
      const p = parseGcashReceipt(text);
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
      if (id !== undefined) await api.updateTransaction(id, payload);
      else await api.addTransaction(payload);
      onDone();
    } catch (e) {
      alert(`Could not save: ${e instanceof Error ? e.message : String(e)}`);
      setSaving(false);
    }
  };

  const save = async () => {
    const amount = parseFloat(form.amount.replace(/,/g, ''));
    if (!Number.isFinite(amount) || amount <= 0) {
      alert('Please enter a valid amount.');
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(form.txnDate.trim())) {
      alert('Please enter the date and time.');
      return;
    }
    const ref = form.refNo.replace(/\s+/g, '');
    if (ref) {
      try {
        const { duplicate: d } = await api.checkRef(ref, id);
        if (
          d &&
          !confirm(
            `Ref ${d.refNo} was already saved by ${d.createdByName} on ${prettyDate(d.txnDate)} (${d.recipient || d.type}).\n\nSave anyway?`,
          )
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
    if (id === undefined || !confirm('Delete this transaction and its receipt image?')) return;
    try {
      await api.deleteTransaction(id);
      onDone();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  };

  const hasImage = Boolean(newImage || savedImageUrl);
  const imageEl = newImage ? (
    <BlobImage blob={newImage} alt="Receipt" />
  ) : (
    <img src={savedImageUrl ?? ''} alt="Receipt" />
  );

  return (
    <div className="page">
      <header className="appbar">
        <button className="icon-btn" aria-label="Back" onClick={onDone}>
          ←
        </button>
        <h1>{id !== undefined ? 'Transaction' : 'New Transaction'}</h1>
        <span className="icon-btn" />
      </header>

      <main className="content">
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
              <button className="link" onClick={() => cameraRef.current?.click()}>
                Retake
              </button>
              <button className="link" onClick={() => galleryRef.current?.click()}>
                Choose another
              </button>
              {newImage && (
                <button className="link" onClick={() => scan(newImage)} disabled={scanning}>
                  Re-scan
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
            {isOwner && createdByName && <div className="muted">Recorded by {createdByName}</div>}

            <label className="label">Type</label>
            <div className="chips">
              {TXN_TYPES.map((t) => (
                <button key={t} className={`chip ${form.type === t ? 'active' : ''}`} onClick={() => set('type', t)}>
                  {t}
                </button>
              ))}
            </div>

            <Field label="Amount (₱)">
              <input className="input" inputMode="decimal" placeholder="0.00" value={form.amount} onChange={(e) => set('amount', e.target.value)} />
            </Field>
            <Field label="Reference No.">
              <input className="input" inputMode="numeric" placeholder="13-digit ref no." value={form.refNo} onChange={(e) => set('refNo', e.target.value)} />
            </Field>
            <Field label="Date & time">
              <input className="input" type="datetime-local" value={toInput(form.txnDate)} onChange={(e) => set('txnDate', fromInput(e.target.value))} />
            </Field>
            <Field label="Name / Merchant">
              <input className="input" placeholder="e.g. JU** DE* C." value={form.recipient} onChange={(e) => set('recipient', e.target.value)} />
            </Field>
            <Field label="Mobile number">
              <input className="input" type="tel" placeholder="+63 9XX XXX XXXX" value={form.phone} onChange={(e) => set('phone', e.target.value)} />
            </Field>
            <Field label="Note">
              <textarea className="input" rows={3} placeholder="What was this for?" value={form.note} onChange={(e) => set('note', e.target.value)} />
            </Field>

            <button className="btn primary block" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : id !== undefined ? 'Save Changes' : 'Save Transaction'}
            </button>
            {id !== undefined && isOwner && (
              <button className="btn danger block" onClick={remove}>
                Delete
              </button>
            )}

            {rawText && (
              <button className="link" onClick={() => setShowRaw((s) => !s)}>
                {showRaw ? 'Hide' : 'Show'} scanned text
              </button>
            )}
            {showRaw && <pre className="raw">{rawText}</pre>}
          </>
        )}
      </main>

      {zoom && hasImage && (
        <div className="zoom" onClick={() => setZoom(false)}>
          {imageEl}
        </div>
      )}
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
