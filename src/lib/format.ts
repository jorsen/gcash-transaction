export const peso = (n: number) =>
  `₱${n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-11-17 17:36" -> "Nov 17, 2026 5:36 PM" */
export function prettyDate(s: string) {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}))?/);
  if (!m) return s;
  const h = m[4] ? parseInt(m[4], 10) : null;
  const time = h === null ? '' : ` ${((h + 11) % 12) + 1}:${m[5]} ${h < 12 ? 'AM' : 'PM'}`;
  return `${MONTHS[parseInt(m[2], 10) - 1]} ${parseInt(m[3], 10)}, ${m[1]}${time}`;
}

export const isIncoming = (type: string) => type === 'Received' || type === 'Cash In';

export const theme = {
  blue: '#007DFE',
  blueDark: '#0057B8',
  bg: '#F3F6FB',
  card: '#FFFFFF',
  text: '#14213D',
  muted: '#6B7A90',
  border: '#E1E7F0',
  green: '#12A150',
  red: '#D93636',
};
