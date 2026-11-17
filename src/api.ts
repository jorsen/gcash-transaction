import type { TxnType } from './parseGcash';

export type Role = 'superadmin' | 'owner' | 'tindera';

export interface User {
  id: number;
  username: string;
  name: string;
  role: Role;
  /** null for the super admin */
  businessId: number | null;
  businessName: string | null;
}

export interface Business {
  id: number;
  name: string;
  active: boolean;
  createdAt: string;
  owners: string;
  tinderaCount: number;
  txnCount: number;
}

export interface StaffUser extends Omit<User, 'businessId' | 'businessName'> {
  /** Devices with notifications turned on. */
  pushDevices: number;
  active: boolean;
  createdAt: string;
  txnCount: number;
}

export interface Txn {
  id: number;
  type: TxnType;
  amount: number;
  refNo: string;
  recipient: string;
  phone: string;
  /** "YYYY-MM-DD HH:mm" local time */
  txnDate: string;
  note: string;
  createdBy: number;
  createdByName: string;
  businessId: number;
  updatedAt: string;
  hasImage: boolean;
  rawText?: string;
}

export interface Summary {
  count: number;
  inflow: number;
  outflow: number;
}

export interface TxnPayload {
  type: TxnType;
  amount: number;
  refNo: string;
  recipient: string;
  phone: string;
  txnDate: string;
  note: string;
  rawText: string;
  /** New image; null removes it; omit to keep the current one. */
  image?: { mime: string; base64: string } | null;
  /** Super admin only: business to record into. */
  businessId?: number;
}

export type RequestKind = 'cashin' | 'cashout';

export interface CashinRequest {
  id: number;
  /** cashin: store sends GCash to the customer. cashout: customer sends GCash to the store, store gives cash. */
  kind: RequestKind;
  /** GCash receipt attached when the owner completed it. */
  txnId: number | null;
  /** "09XXXXXXXXX" */
  number: string;
  /** As GCash shows it; may contain asterisks, e.g. "JU** DE* C." */
  gcashName: string;
  amount: number | null;
  note: string;
  /** pending (blue) -> processing (yellow, owner copied the number) -> done (green) / cancelled */
  status: 'pending' | 'processing' | 'done' | 'cancelled';
  processingAt: string | null;
  processingByName: string | null;
  /** Cash-out only: customer sends from their GCash, or from another bank (InstaPay/PESONet). */
  source: 'gcash' | 'bank';
  bankName: string;
  accountLast4: string;
  refNo: string;
  /** A photo of the customer's transfer receipt was attached. */
  hasProof: boolean;
  /** Times the tindera pressed "Pa cash in po!" again. */
  remindCount: number;
  lastRemindedAt: string | null;
  createdAt: string;
  handledAt: string | null;
  createdBy: number;
  createdByName: string;
  handledByName: string | null;
}

export type ActivityCategory = 'auth' | 'receipt' | 'cashin' | 'staff' | 'business';

export interface ActivityItem {
  id: number;
  /** e.g. "cashin.create", "receipt.delete", "auth.login" */
  action: string;
  summary: string;
  userId: number | null;
  userName: string;
  role: string;
  device: string;
  targetType: 'transaction' | 'cashin' | 'user' | 'business' | null;
  targetId: number | null;
  createdAt: string;
  businessId: number | null;
  businessName: string | null;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Called when any request comes back 401 so the app can show the login screen. */
let onUnauthorized: (() => void) | null = null;
export const setUnauthorizedHandler = (fn: () => void) => {
  onUnauthorized = fn;
};

async function request<T>(method: string, path: string, body?: unknown, opts: { keepalive?: boolean } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/${path}`, {
      method,
      credentials: 'same-origin',
      // keepalive: finish the request even if the user switches to another app right away (e.g. GCash).
      keepalive: opts.keepalive,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'No internet connection. Please check your connection and try again.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && path !== 'login') onUnauthorized?.();
    throw new ApiError(res.status, data.error ?? `Request failed (${res.status}).`);
  }
  return data as T;
}

export const api = {
  session: () => request<{ user: User | null; needsSetup: boolean }>('GET', 'session'),
  setup: (b: { setupCode: string; name: string; username: string; password: string }) =>
    request<{ user: User }>('POST', 'setup', b),
  login: (username: string, password: string) => request<{ user: User }>('POST', 'login', { username, password }),
  logout: () => request<{ ok: true }>('POST', 'logout'),
  changePassword: (current: string, next: string) => request<{ ok: true }>('POST', 'password', { current, next }),

  businesses: () => request<{ businesses: Business[] }>('GET', 'businesses'),
  addBusiness: (b: { name: string; ownerName: string; ownerUsername: string; ownerPassword: string }) =>
    request<{ business: { id: number; name: string } }>('POST', 'businesses', b),
  updateBusiness: (id: number, b: { name?: string; active?: boolean }) => request<{ ok: true }>('PATCH', `businesses/${id}`, b),

  /** businessId is required for the super admin and ignored for everyone else. */
  users: (businessId?: number | null) =>
    request<{ users: StaffUser[] }>('GET', `users${businessId ? `?businessId=${businessId}` : ''}`),
  addUser: (b: { name: string; username: string; password: string; role?: 'owner' | 'tindera'; businessId?: number | null }) =>
    request<{ user: StaffUser }>('POST', 'users', b),
  updateUser: (id: number, b: { name?: string; password?: string; active?: boolean }) =>
    request<{ ok: true }>('PATCH', `users/${id}`, b),

  transactions: (q: { month?: string; search?: string; userId?: number | null; businessId?: number | null }) => {
    const p = new URLSearchParams();
    if (q.businessId) p.set('businessId', String(q.businessId));
    if (q.month) p.set('month', q.month);
    if (q.search) p.set('search', q.search);
    if (q.userId) p.set('userId', String(q.userId));
    return request<{ items: Txn[]; summary: Summary }>('GET', `transactions?${p}`);
  },
  transaction: (id: number) => request<{ txn: Txn }>('GET', `transactions/${id}`),
  addTransaction: (b: TxnPayload) => request<{ id: number }>('POST', 'transactions', b),
  updateTransaction: (id: number, b: TxnPayload) => request<{ ok: true }>('PUT', `transactions/${id}`, b),
  deleteTransaction: (id: number) => request<{ ok: true }>('DELETE', `transactions/${id}`),
  changes: (businessId?: number | null) =>
    request<{ receipts: string; cashin: string; pending: number; latestKind: RequestKind | null; lastRemind: string | null }>('GET', `changes${businessId ? `?businessId=${businessId}` : ''}`),
  activity: (q: { businessId?: number | null; category?: ActivityCategory | null; before?: number; userId?: number }) => {
    const p = new URLSearchParams();
    if (q.businessId) p.set('businessId', String(q.businessId));
    if (q.category) p.set('category', q.category);
    if (q.before) p.set('before', String(q.before));
    if (q.userId) p.set('userId', String(q.userId));
    return request<{ items: ActivityItem[]; more: boolean }>('GET', `activity?${p}`);
  },
  pushKey: () => request<{ publicKey: string }>('GET', 'push/key'),
  pushSubscribe: (sub: PushSubscriptionJSON) => request<{ ok: true }>('POST', 'push/subscribe', sub),
  pushUnsubscribe: (endpoint: string) => request<{ ok: true }>('POST', 'push/unsubscribe', { endpoint }),
  pushTest: (delaySeconds = 0) => request<{ ok: true; devices: number }>('POST', `push/test?delay=${delaySeconds}`),

  cashin: (q: { businessId?: number | null; pendingOnly?: boolean }) => {
    const p = new URLSearchParams();
    if (q.businessId) p.set('businessId', String(q.businessId));
    if (q.pendingOnly) p.set('status', 'pending');
    return request<{ items: CashinRequest[]; pending: number }>('GET', `cashin?${p}`);
  },
  addCashin: (b: {
    number: string;
    gcashName: string;
    amount?: string;
    note?: string;
    businessId?: number | null;
    kind?: RequestKind;
    source?: 'gcash' | 'bank';
    bankName?: string;
    accountLast4?: string;
    refNo?: string;
    proof?: { mime: string; base64: string } | null;
  }) =>
    request<{ id: number }>('POST', 'cashin', b),
  cashinLookup: (number: string, businessId?: number | null) =>
    request<{ names: { name: string; at: string; source: string }[] }>(
      'GET',
      `cashin/lookup?number=${encodeURIComponent(number)}${businessId ? `&businessId=${businessId}` : ''}`,
    ),
  remindCashin: (id: number) => request<{ ok: true; remindCount: number }>('POST', `cashin/${id}/remind`),
  updateCashin: (id: number, status: 'processing' | 'done' | 'cancelled', txnId?: number, opts: { keepalive?: boolean } = {}) =>
    request<{ ok: true }>('PATCH', `cashin/${id}`, { status, txnId }, opts),

  checkRef: (ref: string, excludeId?: number, businessId?: number | null) =>
    request<{ duplicate: { refNo: string; txnDate: string; recipient: string; type: string; createdByName: string } | null }>(
      'GET',
      `check-ref?ref=${encodeURIComponent(ref)}&excludeId=${excludeId ?? 0}${businessId ? `&businessId=${businessId}` : ''}`,
    ),
};

/** Photo of the customer's transfer receipt attached to a cash-out request. */
export const proofUrl = (requestId: number) => `/api/cashin/${requestId}/proof`;

export const imageUrl = (t: Pick<Txn, 'id' | 'updatedAt'>) =>
  `/api/transactions/${t.id}/image?v=${encodeURIComponent(t.updatedAt)}`;

export async function blobToPayload(blob: Blob): Promise<{ mime: string; base64: string }> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
  const [, meta, base64] = dataUrl.match(/^data:([^;]+);base64,(.*)$/) ?? [];
  return { mime: meta || 'image/jpeg', base64: base64 ?? '' };
}
