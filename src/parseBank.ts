/**
 * Reads bank-transfer receipts (InstaPay / PESONet) that customers show for a cash-out,
 * e.g. "From J. GARCIA ••••5340 GoTyme Bank → To Jinkee V ••••9875 G-Xchange, Inc (GCash)".
 * Photos of a phone screen are noisy (glare, cracks), so every field is best-effort and the
 * tindera checks them before sending.
 */
import { parseAmount } from './parseGcash';

export interface BankParty {
  name: string;
  bank: string;
  /** Last 4 digits of the (masked) account number. */
  last4: string;
}

export interface ParsedBankTransfer {
  channel: 'InstaPay' | 'PESONet' | '';
  amount: number | null;
  /** Alphanumeric reference, e.g. "IT026111700551 3003" -> "IT0261117005513003". May be partial. */
  refNo: string;
  /** "YYYY-MM-DD HH:mm" or "" */
  txnDate: string;
  from: BankParty;
  to: BankParty;
}

const BANKS: [RegExp, string][] = [
  [/go\s*ty?me/i, 'GoTyme Bank'],
  [/g-?xchange|gcash/i, 'GCash'],
  [/\bmaya\b|paymaya/i, 'Maya'],
  [/\bbdo\b/i, 'BDO'],
  [/\bbpi\b/i, 'BPI'],
  [/metro\s*bank/i, 'Metrobank'],
  [/union\s*bank/i, 'UnionBank'],
  [/land\s*bank/i, 'LandBank'],
  [/sea\s*bank/i, 'SeaBank'],
  [/security\s*bank/i, 'Security Bank'],
  [/\brcbc\b/i, 'RCBC'],
  [/\bpnb\b|philippine national/i, 'PNB'],
  [/china\s*bank/i, 'China Bank'],
  [/east\s*west/i, 'EastWest'],
  [/ps\s*bank/i, 'PSBank'],
  [/\bcimb\b/i, 'CIMB'],
  [/\btonik\b/i, 'Tonik'],
  [/\buno\s*bank|\buno\b/i, 'UNO Digital Bank'],
  [/\bown\s*bank/i, 'OwnBank'],
  [/\bkomo\b/i, 'Komo'],
  [/shopee\s*pay/i, 'ShopeePay'],
  [/coins\.?ph/i, 'Coins.ph'],
  [/\bdbp\b/i, 'DBP'],
  [/aub|asia united/i, 'AUB'],
];

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n: number) => String(n).padStart(2, '0');

function bankOf(line: string) {
  for (const [re, name] of BANKS) if (re.test(line)) return name;
  return /\bbank\b/i.test(line) ? line.replace(/[^A-Za-z .&-]/g, '').replace(/\s+/g, ' ').trim() : '';
}

/** Name on the "From"/"To" line: "From J. GARCIA pe" -> "J. GARCIA". */
function cleanName(s: string) {
  const words = s
    .replace(/^(from|to)\b[:\s]*/i, '')
    .split(/\s+/)
    .filter(Boolean);
  // Keep leading words that look like a name (letters, dots, apostrophes, hyphens).
  const kept: string[] = [];
  for (const w of words) {
    if (!/^[A-Za-zÑñ][A-Za-zÑñ.'-]*$/.test(w)) break;
    if (kept.length && w.length <= 2 && !/\.$/.test(w) && w === w.toLowerCase()) break; // OCR junk like "pe"
    kept.push(w);
  }
  // Bank receipts show "INITIAL. SURNAME" ("J. GARCIA"). A short undotted piece after a full surname
  // is usually a crack/glare misread ("J. GARCIA WY"); short real surnames ("J. UY") are only 2 words.
  if (kept.length >= 3 && /\.$/.test(kept[0]) && kept[kept.length - 1].length <= 2 && !/\./.test(kept[kept.length - 1])) kept.pop();
  return kept.join(' ').trim();
}

/** Collect a party block: the lines after "From"/"To" until the next label. */
function party(lines: string[], label: 'from' | 'to'): BankParty {
  const start = lines.findIndex((l) => new RegExp(`^\\W*${label}\\b`, 'i').test(l));
  if (start < 0) return { name: '', bank: '', last4: '' };
  const stopper = /^\W*(to|from|amount|fee|total|trace|reference|date|instapay|pesonet)\b/i;
  const block = [lines[start]];
  for (let i = start + 1; i < lines.length && block.length < 6; i++) {
    if (stopper.test(lines[i])) break;
    block.push(lines[i]);
  }
  let name = cleanName(block[0]);
  if (!name && block[1]) name = cleanName(block[1]);
  let bank = '';
  let last4 = '';
  for (const l of block) {
    bank ||= bankOf(l);
    // masked account: "••••••5340", "sseseees 5340", "++0400:0875"
    const m = l.match(/(\d{4})\s*\)?\s*$/) ?? l.match(/(?:[•*.·+:x-]{2,}|[a-z]{4,})\s*:?(\d{4})\b/i);
    if (!last4 && m) last4 = m[1];
  }
  return { name, bank, last4 };
}

function parseDayFirstDate(text: string) {
  // "17 Nov 2026 at 8:55 AM" (also tolerates OCR like "17 Nov2026 at 8:55AM")
  const m = text.match(/\b(\d{1,2})\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*(\d{4})(?:[\s,]*(?:at)?\s*(\d{1,2}):(\d{2})\s*([ap])\.?\s*m)?/i);
  if (!m) return '';
  let h = m[4] ? Number(m[4]) : 0;
  if (m[6]?.toLowerCase() === 'p' && h < 12) h += 12;
  if (m[6]?.toLowerCase() === 'a' && h === 12) h = 0;
  return `${m[3]}-${pad(MONTHS[m[2].toLowerCase()])}-${pad(Number(m[1]))} ${pad(h)}:${m[5] ?? '00'}`;
}

function parseRef(text: string) {
  const m = text.match(/reference\s*n[o0]\.?\s*[:.]?\s*([A-Z0-9][A-Z0-9 §$]{7,32})/i);
  if (!m) return '';
  return m[1]
    .replace(/[§$]/g, '') // OCR noise
    .replace(/\s+/g, '')
    .replace(/^[\[|lI]T/, 'IT') // "[T0261..." / "lT0261..." -> "IT0261..."
    .toUpperCase()
    .slice(0, 30);
}

/** True if the text looks like a bank-transfer receipt rather than a GCash one. */
export function looksLikeBankTransfer(text: string) {
  return /insta\s*[pf]ay|pesonet|trace\s*id|go\s*ty?me|\bbank\b/i.test(text);
}

export function parseBankTransfer(rawText: string): ParsedBankTransfer {
  const lines = rawText
    .split(/\r?\n|\s\|\s/)
    .map((l) => l.trim())
    .filter(Boolean);
  const text = lines.join('\n');
  return {
    channel: /insta\s*[pf]ay/i.test(text) ? 'InstaPay' : /pesonet/i.test(text) ? 'PESONet' : '',
    amount: parseAmount(lines),
    refNo: parseRef(text),
    txnDate: parseDayFirstDate(text),
    from: party(lines, 'from'),
    to: party(lines, 'to'),
  };
}
