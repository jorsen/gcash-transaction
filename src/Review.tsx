import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { prettyDate } from './format';
import { formatDateTime, parseGcashReceipt, TXN_TYPES, type TxnType } from './parseGcash';
import { BlobImage } from './BlobImage';
import { addTxn, deleteTxn, findByRefNo, getTxn, updateTxn, type TxnInput } from './db';
import { compressForStorage } from './image';
import { recognizeText } from './ocr';

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
const fromInput = (s: string) => s.replace('T', ' ');

const emptyForm = (): Form => ({
  type: 'Send Money',
  amount: '',
  refNo: '',
  txnDate: formatDateTime(new Date()),
  recipient: '',
  phone: '',
  note: '',
});

export function Review({ file, id, onDone }: { file?: File; id?: number; onDone: () => void }) {
  const [image, setImage] = useState<Blob | null>(file ?? null);
  const [imageChanged, setImageChanged] = useState(Boolean(file));
  const [rawText, setRawText] = useState('');
  const [form, setForm] = useState<Form>(emptyForm);
  const [scanning, setScanning] = useState(Boolean(file));
  const [progress, setProgress] = useState(0);
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
          'The first scan needs internet to download the text reader. You can still enter the details manually.',
      );
    } finally {
      setScanning(false);
    }
  };

  const scan = (img: Blob) => {
    setScanning(true);
    setProgress(0);
    setNotice('');
    runScan(img);
  };

  useEffect(() => {
    if (file) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- runScan only sets state after awaiting OCR
      runScan(file);
    } else if (id !== undefined) {
      getTxn(id).then((t) => {
        if (!t) return;
        setImage(t.image);
        setRawText(t.rawText);
        setForm({
          type: t.type,
          amount: t.amount.toFixed(2),
          refNo: t.refNo,
          txnDate: t.txnDate,
          recipient: t.recipient,
          phone: t.phone,
          note: t.note,
        });
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    setImage(f);
    setImageChanged(true);
    scan(f);
  };

  const doSave = async () => {
    setSaving(true);
    try {
      const data: TxnInput = {
        type: form.type,
        amount: parseFloat(form.amount.replace(/,/g, '')),
        refNo: form.refNo.replace(/\s+/g, ''),
        recipient: form.recipient.trim(),
        phone: form.phone.trim(),
        txnDate: form.txnDate.trim(),
        note: form.note.trim(),
        image: image && imageChanged ? await compressForStorage(image) : image,
        rawText,
      };
      if (id !== undefined) await updateTxn(id, data);
      else await addTxn(data);
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
    const dup = await findByRefNo(form.refNo.replace(/\s+/g, ''), id);
    if (
      dup &&
      !confirm(
        `Ref ${dup.refNo} was already saved on ${prettyDate(dup.txnDate)} (${dup.recipient || dup.type}).\n\nSave anyway?`,
      )
    ) {
      return;
    }
    doSave();
  };

  const remove = async () => {
    if (id === undefined || !confirm('Delete this transaction and its receipt image?')) return;
    await deleteTxn(id);
    onDone();
  };

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
        {image ? (
          <button className="receipt" onClick={() => setZoom(true)} aria-label="View full receipt">
            <BlobImage blob={image} alt="Receipt" />
          </button>
        ) : (
          <div className="receipt receipt-empty">No receipt image</div>
        )}

        <div className="image-actions">
          <button className="link" onClick={() => cameraRef.current?.click()}>Retake</button>
          <button className="link" onClick={() => galleryRef.current?.click()}>Choose another</button>
          {image && (
            <button className="link" onClick={() => scan(image)} disabled={scanning}>
              Re-scan
            </button>
          )}
        </div>
        <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={onPick} />
        <input ref={galleryRef} type="file" accept="image/*" hidden onChange={onPick} />

        {scanning ? (
          <div className="notice">
            <span className="spinner" /> Reading receipt… {progress > 0 ? `${progress}%` : ''}
          </div>
        ) : (
          notice && <div className="notice">{notice}</div>
        )}

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

        <button className="btn primary block" onClick={save} disabled={saving || scanning}>
          {saving ? 'Saving…' : id !== undefined ? 'Save Changes' : 'Save Transaction'}
        </button>
        {id !== undefined && (
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
      </main>

      {zoom && image && (
        <div className="zoom" onClick={() => setZoom(false)}>
          <BlobImage blob={image} alt="Receipt" />
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
