import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api, blobToPayload, KIND_INFO, proofUrl, type CashinRequest, type RequestKind, type User } from './api';
import { BlobImage } from './BlobImage';
import { CameraSheet } from './CameraSheet';
import { CropSheet } from './CropSheet';
import { compressForStorage, findReceiptCard, isScreenshot, type CropBox } from './image';
import { readRefLine, recognizePasses } from './ocr';
import { looksLikeBankTransfer, parseBankTransfer } from './parseBank';
import { countOf, dateFromReadings, formatDateTime, majority, parseGcashReceipt, parseRefTail, REF_TAIL, voteAmount } from './parseGcash';
import { peso, prettyDate } from './format';
import { markLocalAction, playChime } from './sound';
import { Icon, Lightbox, SkeletonRows, useUi } from './ui';

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

/** Server time minus this phone's time (ms), so timers are right even if the phone's clock is off. */
let clockOffset = 0;
const serverNow = () => Date.now() + clockOffset;

/** 204 s -> "3:24", 3725 s -> "1:02:05". */
function clock(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Minutes after which a still-waiting request's timer turns red. */
const LATE_MINUTES = 5;

/**
 * Running time of a request, ticking every second while it's open:
 * waiting -> "⏱ Waiting 3:24"; processing -> "⏱ Processing 1:05 · waited 3:24"; done -> "Done in 4:29".
 */
function RunningTime({ r }: { r: CashinRequest }) {
  const open = r.status === 'pending' || r.status === 'processing';
  const [now, setNow] = useState(serverNow);
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => setNow(serverNow()), 1000);
    return () => clearInterval(t);
  }, [open]);
  const created = Date.parse(r.createdAt);
  if (r.status === 'pending') {
    const late = now - created >= LATE_MINUTES * 60_000;
    return <span className={`run-time waiting ${late ? 'late' : ''}`}>⏱ Waiting {clock(now - created)}</span>;
  }
  if (r.status === 'processing') {
    const p = r.processingAt ? Date.parse(r.processingAt) : now;
    return (
      <span className="run-time processing">
        ⏱ Processing {clock(now - p)} · waited {clock(p - created)}
      </span>
    );
  }
  if (r.status === 'done' && r.handledAt) return <span className="run-time done">Done in {clock(Date.parse(r.handledAt) - created)}</span>;
  return null;
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

/** The last + menu choice already handled (kept outside the component so it survives remounts). */
let handledRequestNonce = 0;

/** Details read from a customer's cash-out / payment receipt (not editable). */
interface Scanned {
  source: 'gcash' | 'bank';
  channel: string;
  amount: number | null;
  /** How many of the readings gave this amount, and how many read a different amount. */
  votes: number;
  conflicts: number;
  /** At least 2 readings agree on the date (so a misread digit can't block a fresh receipt). */
  dateSure: boolean;
  /** Last 5 digits of the reference number (all a blurry photo reliably shows; enough to tell receipts apart). */
  refNo: string;
  /** Sender's name (bank receipts). */
  name: string;
  bankName: string;
  last4: string;
  /** "YYYY-MM-DD HH:mm" or "" */
  txnDate: string;
  /** GCash receipts: the (masked) name and number the money was sent to, as shown on the receipt. */
  sentToName: string;
  sentToPhone: string;
  /** All the text read, kept with the record. */
  rawText: string;
  /** How much of the time was read: a blurry photo may give only the hour ("around 11 AM"). */
  dateTime?: 'full' | 'hour' | 'none';
}

/** "Nov 18, 2026 11:14 AM", or "Nov 18, 2026, around 11 AM" when only the hour could be read. */
function receiptDateLabel(s: Scanned) {
  const full = prettyDate(s.txnDate);
  if (s.dateTime === 'hour') return full.replace(/ (\d+):00 ([AP]M)$/, ', around $1 $2');
  if (s.dateTime === 'none') return full.replace(/ \d+:\d+ [AP]M$/, '');
  return full;
}

/** Cash-out / payment receipts older than this many days (calendar days) are refused. */
const MAX_RECEIPT_DAYS = 2;

/** Why a scanned receipt can't be sent yet ('' = OK). */
function scanProblem(s: Scanned): string {
  if (s.amount === null) return "Couldn't read the amount. Scan again: hold the phone straight, fill the screen with the receipt, avoid glare.";
  if (s.conflicts > 0 && s.votes < 2) return "The amount wasn't clear (it read differently each time). Scan again with a sharper photo.";
  if (s.source === 'bank' && !s.bankName) return "Couldn't read the bank. Scan again so the sender's bank is visible.";
  if (s.txnDate && s.dateSure) {
    // Receipts from today or the last MAX_RECEIPT_DAYS days (by calendar day) are accepted.
    const day = new Date(`${s.txnDate.slice(0, 10)}T00:00`).getTime();
    const today = new Date(new Date().toDateString()).getTime();
    const daysOld = Math.round((today - day) / 86_400_000);
    if (Number.isFinite(daysOld) && daysOld > MAX_RECEIPT_DAYS) {
      return `This receipt is from ${prettyDate(s.txnDate)} (${daysOld} days ago). Only receipts from the last ${MAX_RECEIPT_DAYS} days are accepted. Ask the customer for their new receipt.`;
    }
  }
  return '';
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
  startRequest,
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
  /** Tindera's + menu: open the form for this kind (a new nonce re-opens it). */
  startRequest?: { kind: RequestKind; nonce: number } | null;
}) {
  const ui = useUi();
  const isManager = user.role !== 'tindera';
  // Only tinderas create requests; owners just handle them.
  const canCreate = user.role === 'tindera';
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
  const [cameraOpen, setCameraOpen] = useState(false);
  const [scanMsg, setScanMsg] = useState('');
  const [scanning, setScanning] = useState(false);
  const [proofView, setProofView] = useState<number | null>(null);
  /** Viewing the photo just scanned (before it's sent), full screen. */
  const [proofPreview, setProofPreview] = useState(false);
  const scanInput = useRef<HTMLInputElement>(null);
  /** Cash-out / payment: the store receives GCash. Details come only from scanning the customer's receipt. */
  const receiving = kind !== 'cashin';
  const isBank = receiving && source === 'bank';
  const [scanned, setScanned] = useState<Scanned | null>(null);
  const problem = scanned ? scanProblem(scanned) : '';
  /** Choosing Cash out / Payment opens the camera right away (Upload is on the camera screen too). */
  const pickKind = (k: RequestKind) => {
    setKind(k);
    if (k !== 'cashin' && !proof) setCameraOpen(true);
  };
  // Tindera picked Cash in / Cash out / Payment from the + menu.
  useEffect(() => {
    // Each + choice is handled once (this screen remounts when switching tabs; don't reopen the camera then).
    if (!startRequest || startRequest.nonce === handledRequestNonce) return;
    handledRequestNonce = startRequest.nonce;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing from the + menu choice
    setKind(startRequest.kind);
    setFormOpen(true);
    if (startRequest.kind !== 'cashin') setCameraOpen(true);
  }, [startRequest]);
  const setBankField = (k: keyof typeof bank, v: string) => setBank((b) => ({ ...b, [k]: v }));

  /**
   * Read the customer's receipt photo, once per area in `crops` (undefined = the whole photo), 3 times each.
   * Every detail is the value most readings agree on, and the amount must come out the same at least twice
   * to be trusted. Stops early once everything (amount, ref no., date) has been read.
   */
  const scanProof = async (file: Blob, crops: (CropBox | undefined)[]): Promise<Scanned | null> => {
    setCropFile(null);
    setProof(file);
    setScanned(null);
    setScanning(true);
    setScanMsg('Reading receipt…');
    try {
      const texts: string[] = [];
      let s: Scanned | null = null;
      for (const crop of crops) {
        texts.push(...(await recognizePasses(file, (p) => setScanMsg(p), { crop, enhance: true, multiPass: true, plainPass: true })));
        s = scannedFrom(texts);
        if (!scanProblem(s) && s.refNo && s.txnDate) break;
      }
      if (s?.source === 'gcash') {
        // Ref no. (last 5) is trusted only when at least 2 readings agree. If the whole-receipt readings
        // don't, read just the ref line again, enlarged, and vote over everything.
        // Same for the date (it sits on the right of the ref line).
        const candidates = texts.map(parseRefTail).filter(Boolean);
        let dateTime: Scanned['dateTime'] = s.txnDate ? 'full' : 'none';
        let { txnDate, dateSure } = s;
        if (countOf(candidates, majority(candidates)) < 2 || !s.txnDate) {
          const line = await readRefLine(file, crops[0], setScanMsg);
          candidates.push(...line.tails.filter(Boolean));
          const d = s.txnDate ? null : dateFromReadings(line.dates, line.times);
          if (d) ({ txnDate, sure: dateSure, time: dateTime } = d);
        }
        const best = majority(candidates);
        s = { ...s, refNo: countOf(candidates, best) >= 2 ? best : '', txnDate, dateSure, dateTime };
      }
      setScanned(s);
      if (s) setSource(s.source);
      setScanMsg('');
      return s;
    } catch (e) {
      setScanMsg(`Couldn't read the receipt (${e instanceof Error ? e.message : String(e)}). Scan again.`);
      return null;
    } finally {
      setScanning(false);
    }
  };

  /** Combines all readings of the receipt into its details. */
  const scannedFrom = (texts: string[]): Scanned => {
    const text = texts.join('\n');
    const { amount, votes, conflicts } = voteAmount(texts);
    if (looksLikeBankTransfer(text)) {
      const per = texts.map(parseBankTransfer);
      const all = parseBankTransfer(text);
      const txnDate = majority(per.map((p) => p.txnDate));
      return {
        source: 'bank',
        channel: all.channel || 'Bank transfer',
        amount,
        votes,
        conflicts,
        dateSure: countOf(per.map((p) => p.txnDate), txnDate) >= 2,
        refNo: (majority(per.map((p) => p.refNo.replace(/\s+/g, '').slice(-REF_TAIL))) || all.refNo.replace(/\s+/g, '')).slice(-REF_TAIL),
        name: (majority(per.map((p) => p.from.name)) || all.from.name).toUpperCase(),
        bankName: majority(per.map((p) => p.from.bank)) || all.from.bank,
        last4: majority(per.map((p) => p.from.last4)) || all.from.last4,
        txnDate: txnDate || all.txnDate,
        sentToName: '',
        sentToPhone: '',
        rawText: text,
      };
    }
    const per = texts.map(parseGcashReceipt);
    const txnDate = majority(per.map((p) => p.txnDate));
    return {
      source: 'gcash',
      channel: 'GCash',
      amount,
      votes,
      conflicts,
      dateSure: countOf(per.map((p) => p.txnDate), txnDate) >= 2,
      refNo: majority(texts.map(parseRefTail)),
      name: '',
      bankName: '',
      last4: '',
      txnDate,
      sentToName: majority(per.map((p) => p.recipient)),
      sentToPhone: majority(per.map((p) => p.phone)),
      rawText: text,
    };
  };

  /**
   * New photo (camera or upload): read it right away. A camera photo of a phone is read on just the
   * white receipt card first (much less background noise), then on the whole photo if something is
   * still missing; the readings are combined. If it still doesn't read clearly, open the framing step.
   */
  const readImage = async (file: Blob) => {
    const card = (await isScreenshot(file)) ? null : await findReceiptCard(file);
    const s = await scanProof(file, card ? [card, undefined] : [undefined]);
    if ((!s || scanProblem(s)) && !(await isScreenshot(file))) setCropFile(file);
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

  /** Status of each request at the last load, to notice "the owner started processing mine". */
  const lastStatus = useRef<Map<number, CashinRequest['status']> | null>(null);
  const load = useCallback(async () => {
    try {
      const r = await api.cashin({ businessId });
      if (r.now) clockOffset = Date.parse(r.now) - Date.now();
      // Tindera: a request of hers went from waiting to processing -> tell her right away.
      const prev = lastStatus.current;
      if (prev && !isManager) {
        const started = r.items.filter((x) => x.status === 'processing' && prev.get(x.id) === 'pending' && x.createdBy === user.id);
        for (const x of started) {
          playChime('receipt');
          ui.toast(`⏳ ${x.processingByName ?? 'The owner'} is processing your ${KIND_INFO[x.kind].label.toLowerCase()} now${x.amount !== null ? ` · ${peso(x.amount)}` : ''}`, 'info');
        }
      }
      lastStatus.current = new Map(r.items.map((x) => [x.id, x.status]));
      setItems(r.items);
      onPendingChange(r.pending);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [businessId, onPendingChange, isManager, user.id, ui]);

  // Load now, and again whenever the realtime stamp says something changed.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load() only sets state after awaiting the API
    load();
  }, [load, liveStamp]);

  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const amountNum = Number(form.amount.replace(/,/g, '').trim());
  const amountOk = form.amount.trim() !== '' && Number.isFinite(amountNum) && amountNum > 0;
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
      if (receiving) {
        // Everything comes from the scan; nothing is typed.
        if (!scanned || !proof || scanProblem(scanned)) throw new Error("Scan the customer's receipt first.");
        await api.addCashin({
          number: '',
          gcashName: scanned.name,
          amount: (scanned.amount as number).toFixed(2),
          note: form.note,
          businessId,
          kind,
          source: scanned.source,
          bankName: scanned.bankName,
          accountLast4: scanned.last4,
          refNo: scanned.refNo,
          receiptName: scanned.sentToName,
          receiptPhone: scanned.sentToPhone,
          // Only the day read (no time) and it's today: let the server use "now" rather than midnight.
          receiptDate:
            scanned.dateTime === 'none' && scanned.txnDate.slice(0, 10) === formatDateTime(new Date()).slice(0, 10) ? '' : scanned.txnDate,
          rawText: scanned.rawText,
          proof: await blobToPayload(await compressForStorage(proof).catch(() => proof)),
        });
        ui.toast(`Sent to the owner: ${KIND_INFO[kind].label} ${peso(scanned.amount as number)}`);
      } else {
        await api.addCashin({ ...form, number: digits, businessId, kind, source: 'gcash', bankName: '', accountLast4: '', refNo: '', proof: null });
        ui.toast(`Sent to the owner: ${form.number}`);
      }
      setForm({ number: '', gcashName: '', amount: '', note: '' });
      setBank({ bankName: '', accountLast4: '', refNo: '' });
      setScanned(null);
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
        title: `Cancel this ${KIND_INFO[r.kind].label.toLowerCase()}?`,
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
      ui.toast(status === 'done' ? (r.kind === 'cashin' ? 'Marked as sent' : 'Marked as received') : 'Request cancelled', status === 'done' ? 'success' : 'info');
      await load();
    } catch (err) {
      ui.toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const pending = items.filter(isOpen);
  const finished = items.filter((r) => !isOpen(r));

  const doneWord = (r: CashinRequest) => (r.kind === 'cashin' ? 'Sent' : 'Received');
  const statusLabel = (r: CashinRequest) =>
    r.status === 'pending' ? 'Waiting' : r.status === 'processing' ? 'Processing' : r.status === 'done' ? doneWord(r) : 'Cancelled';

  const card = (r: CashinRequest) => (
    <li key={r.id} className={`cashin-card ${r.status} kind-${r.kind}`}>
      <span className={`kind-badge ${r.kind}`}>{KIND_INFO[r.kind].label}</span>
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
      <RunningTime r={r} />
      {(r.source === 'bank' || r.refNo) && (
        <div className="row-sub">
          {r.source === 'bank' ? 'InstaPay / bank transfer to GCash' : 'GCash'}
          {r.refNo ? ` · Ref …${r.refNo.slice(-REF_TAIL)}` : ''}
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
          <Icon name="receipt" size={16} /> {r.kind === 'cashin' ? 'View GCash receipt' : 'View saved record'}
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
            {isManager && r.kind !== 'cashin' && (
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
              🔔 {r.kind === 'payment' ? 'May bayad po!' : r.kind === 'cashout' ? 'Pa cash out po!' : 'Pa cash in po!'}
              <small>{remindCooldown[r.id] ? 'Sent to owner' : 'Tap to remind the owner'}</small>
            </button>
          )}
          {isManager && r.kind !== 'cashin' && (
            <span className="hint">
              Check that {r.amount !== null ? peso(r.amount) : 'the money'} arrived in the store's GCash
              {r.source === 'bank' ? ` from ${r.bankName || 'the bank'}` : ''}, then tap Received. {r.kind === 'payment' ? "It's saved as a payment." : "It's saved as a received transaction."}
            </span>
          )}
          {isManager && r.kind !== 'cashin' && !r.hasProof && (
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
      <Icon name="plus" size={20} /> New request
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
              <button type="button" role="tab" aria-selected={kind === 'cashout'} className={kind === 'cashout' ? 'active' : ''} onClick={() => pickKind('cashout')}>
                Cash out
              </button>
              <button type="button" role="tab" aria-selected={kind === 'payment'} className={kind === 'payment' ? 'active' : ''} onClick={() => pickKind('payment')}>
                Payment
              </button>
            </div>
            <span className="hint">
              {kind === 'cashin'
                ? 'Customer pays cash; the owner sends GCash to their number.'
                : kind === 'payment'
                  ? "Customer pays for items by sending GCash to the store; the owner confirms it arrived."
                  : 'Customer sends money to the store\'s GCash; the owner confirms, then you give the cash.'}
            </span>
          </div>
          {receiving && (
            <div className="scan-proof">
              {proof && (
                <button type="button" className="proof-thumb" aria-label="View the receipt photo" onClick={() => setProofPreview(true)}>
                  <BlobImage blob={proof} alt="Customer's receipt" />
                </button>
              )}
              <div className="scan-proof-main">
                <div className="scan-buttons">
                  <button type="button" className="btn secondary grow" onClick={() => setCameraOpen(true)} disabled={scanning}>
                    <Icon name="camera" size={20} /> {proof ? 'Scan again' : "Scan customer's receipt"}
                  </button>
                  <button type="button" className="btn secondary" onClick={() => scanInput.current?.click()} disabled={scanning} aria-label="Upload a photo">
                    <Icon name="image" size={20} /> Upload
                  </button>
                </div>
                {scanMsg ? (
                  <span className={`hint ${scanning ? '' : 'known'}`}>
                    {scanning && <span className="spinner" />} {scanMsg}
                  </span>
                ) : (
                  <span className="hint">Scan the customer's GCash or bank receipt. The details are read from it (they can't be typed) and it's kept as proof.</span>
                )}
                {proof && !scanning && (
                  <button type="button" className="link danger-text small-link" onClick={() => { setProof(null); setScanned(null); setScanMsg(''); }}>
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
                  if (f) readImage(f);
                }}
              />
            </div>
          )}
          {receiving && scanned && !scanning && (
            <div className={`scan-result ${problem ? 'bad' : 'ok'}`}>
              <div className="scan-result-head">{problem ? '⚠ Scan again' : '✓ Read from the receipt'}</div>
              {problem && <p className="scan-problem">{problem}</p>}
              <dl>
                <dt>Amount</dt>
                <dd className="scan-amount">{scanned.amount !== null ? peso(scanned.amount) : '—'}</dd>
                <dt>Sent via</dt>
                <dd>{scanned.source === 'bank' ? `${scanned.bankName || 'Bank'}${scanned.last4 ? ` ••${scanned.last4}` : ''} (${scanned.channel})` : 'GCash'}</dd>
                {scanned.name && (
                  <>
                    <dt>Sender</dt>
                    <dd className="mono">{scanned.name}</dd>
                  </>
                )}
                {(scanned.sentToName || scanned.sentToPhone) && (
                  <>
                    <dt>Sent to</dt>
                    <dd className="mono">
                      {scanned.sentToName && <MaskedName name={scanned.sentToName} className="" />}
                      {scanned.sentToName && scanned.sentToPhone && ' · '}
                      {scanned.sentToPhone}
                    </dd>
                  </>
                )}
                <dt>Ref no. (last 5)</dt>
                <dd className="mono">{scanned.refNo ? `…${scanned.refNo}` : '—'}</dd>
                <dt>Date &amp; time</dt>
                <dd>{scanned.txnDate ? receiptDateLabel(scanned) : '—'}</dd>
              </dl>
            </div>
          )}
          {!receiving && (
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
          )}
          {!receiving && (
          <>
          <label className="field">
            <span className="label">GCash name</span>
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
            <input
              className="input"
              inputMode="decimal"
              placeholder="0.00"
              value={form.amount}
              onChange={(e) => set('amount', e.target.value.replace(/[^\d.,]/g, ''))}
              required
            />
            {form.amount.trim() !== '' && !amountOk && <span className="number-status bad">✗ Enter a valid amount</span>}
          </label>
          </>
          )}
          <label className="field">
            <span className="label">Note (optional)</span>
            <input className="input" value={form.note} onChange={(e) => set('note', e.target.value)} />
          </label>
          {formError && <div className="error">{formError}</div>}
          <button
            className="btn primary block"
            disabled={sending || scanning || (receiving ? !scanned || !proof || Boolean(problem) : !amountOk || !status?.ok)}
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
      {cameraOpen && (
        <CameraSheet
          title="Scan the customer's receipt"
          onCancel={() => setCameraOpen(false)}
          onCapture={(photo) => {
            setCameraOpen(false);
            readImage(photo);
          }}
          onGallery={() => {
            setCameraOpen(false);
            scanInput.current?.click();
          }}
        />
      )}
      {cropFile && (
        <CropSheet
          file={cropFile}
          title="Frame just the receipt to read it clearly"
          onCancel={() => setCropFile(null)}
          onDone={(crop) => scanProof(cropFile, [crop])}
        />
      )}
      {proofView !== null && (
        <Lightbox onClose={() => setProofView(null)} label="Customer's transfer receipt">
          <img src={proofUrl(proofView)} alt="Customer's transfer receipt" />
        </Lightbox>
      )}
      {proofPreview && proof && (
        <Lightbox onClose={() => setProofPreview(false)} label="Customer's receipt">
          <BlobImage blob={proof} alt="Customer's receipt" />
        </Lightbox>
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
