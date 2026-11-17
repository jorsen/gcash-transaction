import { useCallback, useEffect, useState } from 'react';
import { api, type ActivityCategory, type ActivityItem, type User } from './api';
import { Avatar, Icon, SkeletonRows, type IconName } from './ui';

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ymd = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

function dayLabel(d: Date) {
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (ymd(d) === ymd(today)) return 'Today';
  if (ymd(d) === ymd(yesterday)) return 'Yesterday';
  return `${DAYS[d.getDay()]}, ${SHORT_MONTHS[d.getMonth()]} ${d.getDate()}${d.getFullYear() !== today.getFullYear() ? `, ${d.getFullYear()}` : ''}`;
}
const timeLabel = (d: Date) => d.toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' });

const CATEGORY_ICON: Record<ActivityCategory, IconName> = {
  auth: 'key',
  receipt: 'receipt',
  cashin: 'cash',
  staff: 'users',
  business: 'store',
};

/** Icon for a specific action (falls back to the category icon). */
function actionIcon(action: string): IconName {
  if (action === 'auth.logout') return 'logout';
  if (action === 'receipt.delete') return 'trash';
  if (action === 'receipt.update' || action === 'staff.rename' || action === 'business.rename') return 'edit';
  if (action === 'cashin.remind') return 'bell';
  if (action === 'cashin.done') return 'check';
  if (action === 'cashin.cancel' || action === 'staff.deactivate' || action === 'business.deactivate') return 'close';
  return CATEGORY_ICON[action.split('.')[0] as ActivityCategory] ?? 'more';
}

/** Tone of the row: red for deletions/failures, green for completions. */
function actionTone(action: string) {
  if (/delete|login_failed|deactivate|cancel/.test(action)) return 'bad';
  if (/done|activate|create/.test(action)) return 'good';
  if (action === 'cashin.remind') return 'warn';
  return '';
}

const ROLE_LABEL: Record<string, string> = { superadmin: 'Super admin', owner: 'Owner', tindera: 'Tindera' };

/**
 * Activity log: who did what, when, on which device.
 * Owner: their business. Super admin: the chosen business, or all businesses.
 */
export function Activity({
  user,
  businessId,
  businessName,
  onBack,
  onOpenReceipt,
}: {
  user: User;
  /** Super admin: the business to show, or null for all businesses. Ignored for owners. */
  businessId: number | null;
  businessName: string;
  onBack: () => void;
  onOpenReceipt: (id: number) => void;
}) {
  const isSuper = user.role === 'superadmin';
  const allBusinesses = isSuper && businessId === null;
  const [category, setCategory] = useState<ActivityCategory | null>(null);
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const r = await api.activity({ businessId, category });
      setItems(r.items);
      setMore(r.more);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [businessId, category]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load() is an async fetch
    load();
  }, [load]);

  const loadMore = async () => {
    const last = items[items.length - 1];
    if (!last) return;
    setLoadingMore(true);
    try {
      const r = await api.activity({ businessId, category, before: last.id });
      setItems((list) => [...list, ...r.items]);
      setMore(r.more);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingMore(false);
    }
  };

  const filters: { key: ActivityCategory | null; label: string }[] = [
    { key: null, label: 'All' },
    { key: 'cashin', label: 'Cash-in' },
    { key: 'receipt', label: 'Receipts' },
    { key: 'staff', label: 'Staff' },
    { key: 'auth', label: 'Logins' },
    ...(isSuper ? [{ key: 'business' as const, label: 'Businesses' }] : []),
  ];

  // Group by day (newest first).
  const groups: { label: string; items: ActivityItem[] }[] = [];
  for (const it of items) {
    const label = dayLabel(new Date(it.createdAt));
    const g = groups[groups.length - 1];
    if (g && g.label === label) g.items.push(it);
    else groups.push({ label, items: [it] });
  }

  return (
    <div className="page">
      <header className="appbar">
        <button className="icon-btn" aria-label="Back" onClick={onBack}>
          <Icon name="back" />
        </button>
        <div className="appbar-title">
          <h1>Activity log</h1>
          <small>{allBusinesses ? 'All businesses' : businessName}</small>
        </div>
        <button className="icon-btn" aria-label="Refresh" onClick={load}>
          <Icon name="refresh" />
        </button>
      </header>

      <main className="content">
        <div className="chips scroll">
          {filters.map((f) => (
            <button key={f.label} className={`chip ${category === f.key ? 'active' : ''}`} onClick={() => setCategory(f.key)}>
              {f.label}
            </button>
          ))}
        </div>

        {error ? (
          <div className="empty-state">
            <p className="error">{error}</p>
            <button className="btn secondary" onClick={load}>
              Try again
            </button>
          </div>
        ) : loading ? (
          <SkeletonRows count={6} />
        ) : items.length === 0 ? (
          <div className="empty-state">
            <span className="empty-icon">
              <Icon name="more" size={34} />
            </span>
            <strong>No activity yet</strong>
            <p>Logins, receipts, cash-in requests and staff changes will show up here.</p>
          </div>
        ) : (
          <>
            {groups.map((g) => (
              <section key={g.label} className="day-group">
                <div className="day-head">
                  <span>{g.label}</span>
                </div>
                <ul className="list activity-list">
                  {g.items.map((it) => {
                    const opensReceipt = it.targetType === 'transaction' && it.targetId && it.action !== 'receipt.delete';
                    const body = (
                      <>
                        <span className={`activity-icon ${actionTone(it.action)}`}>
                          <Icon name={actionIcon(it.action)} size={18} />
                        </span>
                        <span className="row-main">
                          <span className="activity-who">
                            {it.userName ? <Avatar name={it.userName} size={18} /> : null}
                            <strong>{it.userName || 'Someone'}</strong>
                            {it.role && <span className="activity-role">{ROLE_LABEL[it.role] ?? it.role}</span>}
                            {allBusinesses && it.businessName && <span className="activity-biz">{it.businessName}</span>}
                          </span>
                          <span className="activity-summary">{it.summary}</span>
                          <span className="row-sub">
                            {timeLabel(new Date(it.createdAt))}
                            {it.device ? ` · ${it.device}` : ''}
                          </span>
                        </span>
                        {opensReceipt && <Icon name="chevronRight" className="chevron" />}
                      </>
                    );
                    return (
                      <li key={it.id}>
                        {opensReceipt ? (
                          <button className="activity-row" onClick={() => onOpenReceipt(it.targetId as number)}>
                            {body}
                          </button>
                        ) : (
                          <div className="activity-row">{body}</div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
            {more && (
              <button className="btn secondary block" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? 'Loading…' : 'Load more'}
              </button>
            )}
          </>
        )}
      </main>
    </div>
  );
}
