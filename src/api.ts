import type { TxnType } from './parseGcash';

export type Role = 'owner' | 'tindera';

export interface User {
  id: number;
  username: string;
  name: string;
  role: Role;
}

export interface StaffUser extends User {
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

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/${path}`, {
      method,
      credentials: 'same-origin',
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

  users: () => request<{ users: StaffUser[] }>('GET', 'users'),
  addUser: (b: { name: string; username: string; password: string }) => request<{ user: StaffUser }>('POST', 'users', b),
  updateUser: (id: number, b: { name?: string; password?: string; active?: boolean }) =>
    request<{ ok: true }>('PATCH', `users/${id}`, b),

  transactions: (q: { month?: string; search?: string; userId?: number | null }) => {
    const p = new URLSearchParams();
    if (q.month) p.set('month', q.month);
    if (q.search) p.set('search', q.search);
    if (q.userId) p.set('userId', String(q.userId));
    return request<{ items: Txn[]; summary: Summary }>('GET', `transactions?${p}`);
  },
  transaction: (id: number) => request<{ txn: Txn }>('GET', `transactions/${id}`),
  addTransaction: (b: TxnPayload) => request<{ id: number }>('POST', 'transactions', b),
  updateTransaction: (id: number, b: TxnPayload) => request<{ ok: true }>('PUT', `transactions/${id}`, b),
  deleteTransaction: (id: number) => request<{ ok: true }>('DELETE', `transactions/${id}`),
  checkRef: (ref: string, excludeId?: number) =>
    request<{ duplicate: { refNo: string; txnDate: string; recipient: string; type: string; createdByName: string } | null }>(
      'GET',
      `check-ref?ref=${encodeURIComponent(ref)}&excludeId=${excludeId ?? 0}`,
    ),
};

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
