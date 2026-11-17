/**
 * Turns the raw OCR text of a GCash receipt screenshot/photo into structured fields.
 *
 * GCash receipts vary by transaction type (Express Send, Pay Bills, Bank Transfer,
 * Cash In, Buy Load, QR payments...), and OCR output is noisy, so every field is
 * best-effort. The user reviews and corrects the result before it is saved.
 */

export type TxnType =
  | 'Send Money'
  | 'Received'
  | 'Payment'
  | 'Bank Transfer'
  | 'Cash In'
  | 'Cash Out'
  | 'Buy Load'
  | 'Other';

export const TXN_TYPES: TxnType[] = [
  'Send Money',
  'Received',
  'Payment',
  'Bank Transfer',
  'Cash In',
  'Cash Out',
  'Buy Load',
  'Other',
];

export interface ParsedReceipt {
  type: TxnType;
  amount: number | null;
  refNo: string;
  /** Local date-time formatted as "YYYY-MM-DD HH:mm", or "" if not found. */
  txnDate: string;
  recipient: string;
  phone: string;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

const pad = (n: number) => String(n).padStart(2, '0');

export function formatDateTime(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toNumber(s: string): number | null {
  const n = parseFloat(s.replace(/[,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// Matches money like "1,234.56", "500.00", "₱ 500.00", "PHP 500.00", "P500.00".
const MONEY = /(?:₱|PHP|Php|P)?\s?(\d{1,3}(?:[,\s]\d{3})*\.\d{2}|\d+\.\d{2})\b/;
const MONEY_G = new RegExp(MONEY.source, 'g');

/**
 * Fixes common OCR slips in money: "1.000.00" -> "1,000.00" (thousands dot), "500,00" -> "500.00"
 * (decimal comma), "1, 000.00" -> "1,000.00", and O/o read for 0 inside a number ("1,0O0.00").
 */
export function normalizeMoney(line: string): string {
  let s = line.replace(/(\d)[Oo](?=[\d.,Oo]*\d)/g, '$10').replace(/(\d)[Oo](?=[.,]\d{2}\b)/g, '$10');
  s = s.replace(/(\d)\s*,\s+(\d{3})/g, '$1,$2');
  let prev;
  do {
    prev = s;
    s = s.replace(/(?<![\d.,])(\d{1,3})\.(\d{3})(?=[.,]\d{2}\b)/g, '$1,$2');
  } while (s !== prev);
  return s.replace(/(?<![\d.,])(\d{1,3}(?:,\d{3})*|\d+),(\d{2})\b(?![,.]?\d)/g, '$1.$2');
}

/**
 * Best amount across several readings of the same receipt: the value most readings agree on
 * (ties go to the earlier reading). One misread digit in one reading is outvoted by the others.
 */
export function pickAmount(texts: string[]): number | null {
  const votes = new Map<number, number>();
  const order: number[] = [];
  for (const t of texts) {
    const a = parseAmount(t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
    if (a === null) continue;
    if (!votes.has(a)) order.push(a);
    votes.set(a, (votes.get(a) ?? 0) + 1);
  }
  let best: number | null = null;
  for (const a of order) if (best === null || votes.get(a)! > votes.get(best)!) best = a;
  return best;
}

export function parseAmount(rawLines: string[]): number | null {
  const lines = rawLines.map(normalizeMoney);
  // Most specific labels first. The value is on the same line or the next one.
  const labels = [
    /total\s+amount\s+sent/i,
    /total\s+amount/i,
    /amount\s+(?:sent|paid|due)/i,
    /^\s*total\b/i,
    /^\s*amount\b/i,
  ];
  for (const label of labels) {
    for (let i = 0; i < lines.length; i++) {
      if (!label.test(lines[i])) continue;
      // ₱0.00 (e.g. "Fee 0.00" read under the label) is never the amount.
      const same = toNumber(lines[i].match(MONEY)?.[1] ?? '');
      if (same) return same;
      const next = toNumber(lines[i + 1]?.match(MONEY)?.[1] ?? '');
      if (next) return next;
    }
  }
  // Fallback: the largest money-looking value on the receipt.
  const all = [...lines.join('\n').matchAll(MONEY_G)]
    .map((m) => toNumber(m[1]))
    .filter((n): n is number => n !== null && n > 0);
  return all.length ? Math.max(...all) : null;
}

function parseRefNo(text: string): string {
  // "Ref No. 1234 567 890123", "Reference No.: 1234567890123", "Ref. No 1234 567 890123"
  const m = text.match(/ref(?:erence)?\.?\s*(?:no|number|#)?\.?\s*:?\s*([0-9][0-9 ]{6,20}[0-9])/i);
  if (m) return m[1].replace(/\s+/g, '');
  // Fallback: a standalone 13-digit GCash reference, possibly grouped 4-3-6.
  const g = text.match(/\b(\d{4}\s?\d{3}\s?\d{6})\b/);
  return g ? g[1].replace(/\s+/g, '') : '';
}

function parseDate(text: string): string {
  // "Nov 17, 2026 5:36 PM" / "Nov 17, 2026, 05:36 PM" / "November 17 2026 5:36PM"
  const m = text.match(
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4}),?\s*(?:(\d{1,2}):(\d{2})\s*([ap])\.?\s*m\.?)?/i,
  );
  if (m) {
    const month = MONTHS[m[1].toLowerCase()];
    let hour = m[4] ? parseInt(m[4], 10) : 0;
    const min = m[5] ? parseInt(m[5], 10) : 0;
    if (m[6]) {
      const pm = m[6].toLowerCase() === 'p';
      if (pm && hour < 12) hour += 12;
      if (!pm && hour === 12) hour = 0;
    }
    return `${m[3]}-${pad(month)}-${pad(parseInt(m[2], 10))} ${pad(hour)}:${pad(min)}`;
  }
  // "11/17/2026 17:36" or "11-17-2026 5:36 PM"
  const n = text.match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:\s+(\d{1,2}):(\d{2})\s*([ap]m)?)?/i);
  if (n) {
    let hour = n[4] ? parseInt(n[4], 10) : 0;
    if (n[6]?.toLowerCase() === 'pm' && hour < 12) hour += 12;
    if (n[6]?.toLowerCase() === 'am' && hour === 12) hour = 0;
    return `${n[3]}-${pad(parseInt(n[1], 10))}-${pad(parseInt(n[2], 10))} ${pad(hour)}:${n[5] ?? '00'}`;
  }
  return '';
}

const PHONE = /(\+63\s?9\d{2}\s?\d{3}\s?\d{4}|\b09\d{2}\s?\d{3}\s?\d{4})\b/;

function parseType(text: string): TxnType {
  const t = text.toLowerCase();
  if (/cash\s*-?\s*in/.test(t)) return 'Cash In';
  if (/cash\s*-?\s*out/.test(t)) return 'Cash Out';
  if (/buy\s+load|load\s+purchase|airtime/.test(t)) return 'Buy Load';
  if (/bank\s+transfer|instapay|pesonet|transfer\s+to\s+bank/.test(t)) return 'Bank Transfer';
  if (/received|you\s+have\s+received|money\s+received/.test(t)) return 'Received';
  if (/sent\s+via\s+gcash|express\s+send|send\s+money|successfully\s+sent|amount\s+sent/.test(t)) return 'Send Money';
  if (/paid|payment|pay\s+bills|biller|merchant|scan\s+to\s+pay|qr\s*ph/.test(t)) return 'Payment';
  return 'Other';
}

function parseRecipient(lines: string[], phoneLineIdx: number): string {
  const skip = /gcash|sent|receipt|successful|amount|total|ref|php|₱|\d{2}:\d{2}|^\W*$/i;
  // GCash usually shows the (masked) name directly above the mobile number.
  if (phoneLineIdx > 0) {
    for (let i = phoneLineIdx - 1; i >= Math.max(0, phoneLineIdx - 2); i--) {
      if (!skip.test(lines[i])) return lines[i].replace(/^(from|to)\s+/i, '').trim();
    }
  }
  // Otherwise look for "Paid to X" / "Sent to X" / "Biller X".
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(?:paid\s+to|sent\s+to|biller|merchant|to)\s*:?\s*(.*)$/i);
    if (m) {
      const value = m[1].trim() || lines[i + 1]?.trim() || '';
      if (value && !skip.test(value)) return value;
    }
  }
  return '';
}

/** The character GCash uses to hide letters in names, e.g. "AL•••N C." */
export const MASK = '•';

/** Tall lowercase letters are real letters misread in lowercase (e.g. "l" in "AleeeN" is an L), not dots. */
const TALL = /[bdfhiklt]/;

/** True if this word looks like a GCash-masked word that OCR garbled: Capitals, then junk, then a Capital. */
function looksMasked(core: string) {
  return /^[A-Z][A-Z]*[^A-Z\s]+[A-Z0]/.test(core) || /^[A-Z]+[*•·.\-<>¢°~_]+$/.test(core);
}

function fixMaskedWord(word: string): string {
  // Keep a trailing initial dot / comma ("C." / "C,") as written.
  const m = word.match(/^(.*?)([.,]?)$/);
  let core = m?.[1] ?? word;
  const tail = m?.[2] === ',' ? '.' : (m?.[2] ?? '');
  if (!/^[A-Z]/.test(core) || /^[A-Z]+$/.test(core)) return core + tail;
  // A 0 at the very end of a masked word is an O ("RO••0" -> "RO••O").
  core = core.replace(/0$/, 'O');
  let i = 1;
  while (i < core.length && /[A-Z]/.test(core[i])) i++;
  // Lowercase tall letters right after the visible start are real letters ("Al…" -> "AL…").
  while (i < core.length && TALL.test(core[i])) i++;
  let j = core.length;
  while (j > i && /[A-Z]/.test(core[j - 1])) j--;
  const prefix = core.slice(0, i).toUpperCase();
  const middle = core.slice(i, j);
  const suffix = core.slice(j);
  return prefix + MASK.repeat(middle.length) + suffix + tail;
}

/**
 * GCash hides most letters of a person's name with dots ("AL•••N C."). OCR reads those dots as
 * stray characters ("AleeeN C.", "CHe..<<R", "JO-N B."). This turns them back into dots, but only for
 * names that look masked, so normal merchant names ("Meralco") are left alone.
 */
export function normalizeMaskedName(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, ' ');
  const words = trimmed.split(' ');
  const masked = words.some((w) => looksMasked(w.replace(/[.,]$/, '')) || /[*•]/.test(w));
  if (!masked) return trimmed;
  return words.map((w) => fixMaskedWord(w.replace(/\*/g, MASK))).join(' ');
}

export function parseGcashReceipt(rawText: string): ParsedReceipt {
  const lines = rawText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const text = lines.join('\n');

  const phoneIdx = lines.findIndex((l) => PHONE.test(l));
  const phone = phoneIdx >= 0 ? (lines[phoneIdx].match(PHONE)?.[1] ?? '').replace(/\s+/g, '') : '';

  return {
    type: parseType(text),
    amount: parseAmount(lines),
    refNo: parseRefNo(text),
    txnDate: parseDate(text),
    recipient: normalizeMaskedName(parseRecipient(lines, phoneIdx)),
    phone,
  };
}

/**
 * Combines several readings of one receipt (best reading first): fields come from the first reading
 * that has them, and the amount is the one most readings agree on.
 */
export function parseGcashPasses(texts: string[]): ParsedReceipt {
  const all = texts.map(parseGcashReceipt);
  const p = { ...all[0] };
  for (const o of all.slice(1)) {
    if (p.type === 'Other') p.type = o.type;
    p.refNo ||= o.refNo;
    p.txnDate ||= o.txnDate;
    p.recipient ||= o.recipient;
    p.phone ||= o.phone;
  }
  p.amount = pickAmount(texts) ?? p.amount;
  return p;
}
