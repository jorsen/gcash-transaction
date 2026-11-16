import { createContext, useCallback, useContext, useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { PasswordInput } from './PasswordInput';

/* ------------------------------------------------------------------ */
/* Icons (inline SVG, inherit currentColor)                            */
/* ------------------------------------------------------------------ */

const paths = {
  camera: 'M9 4h6l1.5 2H20a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3.5L9 4Zm3 4.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9Zm0 2a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5Z',
  image: 'M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm0 11.6V18h16v-1.2l-4.5-4.6-3.6 3.7-2.4-2.5L4 15.6ZM8 7a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z',
  receipt: 'M5 2h14v20l-2.3-1.6L14.3 22 12 20.4 9.7 22l-2.4-1.6L5 22V2Zm3 5v2h8V7H8Zm0 4v2h8v-2H8Zm0 4v2h5v-2H8Z',
  cash: 'M2 6h20v12H2V6Zm2 2v8h16V8H4Zm8 1.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5ZM5 9h2v2H5V9Zm12 4h2v2h-2v-2Z',
  plus: 'M11 4h2v7h7v2h-7v7h-2v-7H4v-2h7V4Z',
  back: 'M20 11H7.8l5.6-5.6L12 4l-8 8 8 8 1.4-1.4L7.8 13H20v-2Z',
  chevronLeft: 'M15.4 7.4 14 6l-6 6 6 6 1.4-1.4L10.8 12l4.6-4.6Z',
  chevronRight: 'M8.6 16.6 10 18l6-6-6-6-1.4 1.4 4.6 4.6-4.6 4.6Z',
  search: 'M10 3a7 7 0 0 1 5.6 11.2l5.1 5.1-1.4 1.4-5.1-5.1A7 7 0 1 1 10 3Zm0 2a5 5 0 1 0 0 10 5 5 0 0 0 0-10Z',
  copy: 'M8 3h11a2 2 0 0 1 2 2v11h-2V5H8V3Zm-3 4h10a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Zm0 2v11h10V9H5Z',
  check: 'M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2Z',
  close: 'M18.3 5.7 16.9 4.3 12 9.2 7.1 4.3 5.7 5.7 10.6 12l-4.9 4.9 1.4 1.4 4.9-4.9 4.9 4.9 1.4-1.4-4.9-4.9 4.9-4.9Z',
  bell: 'M12 22a2.5 2.5 0 0 0 2.5-2.5h-5A2.5 2.5 0 0 0 12 22Zm7-6V11a7 7 0 0 0-5.5-6.8V3a1.5 1.5 0 0 0-3 0v1.2A7 7 0 0 0 5 11v5l-2 2v1h18v-1l-2-2Z',
  users: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0 2c-3.3 0-7 1.7-7 4.5V20h14v-2.5C16 14.7 12.3 13 9 13Zm8.5-2a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm.5 2c-.6 0-1.2.1-1.8.2 1.4 1 2.3 2.5 2.3 4.3V20H23v-2.5c0-2.6-2.9-4.5-5-4.5Z',
  download: 'M11 3h2v9.2l3.6-3.6L18 10l-6 6-6-6 1.4-1.4 3.6 3.6V3ZM4 18h16v2H4v-2Z',
  key: 'M7 14a3 3 0 1 1 0-6 3 3 0 0 1 0 6Zm5.6-4A6 6 0 1 0 12.6 14H17v3h3v-3h2v-4h-9.4Z',
  logout: 'M10 17l1.4-1.4-2.6-2.6H20v-2H8.8l2.6-2.6L10 7l-5 5 5 5ZM4 3h8v2H4v14h8v2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z',
  store: 'M4 4h16l1 5a3 3 0 0 1-2 2.8V20H5v-8.2A3 3 0 0 1 3 9l1-5Zm3 9v5h10v-5H7Z',
  more: 'M12 7a2 2 0 1 1 0-4 2 2 0 0 1 0 4Zm0 7a2 2 0 1 1 0-4 2 2 0 0 1 0 4Zm0 7a2 2 0 1 1 0-4 2 2 0 0 1 0 4Z',
  edit: 'M3 17.2V21h3.8L17.8 10l-3.8-3.8L3 17.2ZM20.7 7a1 1 0 0 0 0-1.4l-2.3-2.3a1 1 0 0 0-1.4 0l-1.8 1.8 3.8 3.8L20.7 7Z',
  trash: 'M6 7h12l-1 14H7L6 7Zm3-4h6l1 2h4v2H4V5h4l1-2Z',
  install: 'M12 16 7 11l1.4-1.4 2.6 2.6V2h2v10.2l2.6-2.6L17 11l-5 5ZM5 20v-4H3v4a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-4h-2v4H5Z',
} as const;

export type IconName = keyof typeof paths;

export function Icon({ name, size = 22, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" className={className}>
      <path fill="currentColor" d={paths[name]} />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Avatar                                                              */
/* ------------------------------------------------------------------ */

const AVATAR_COLORS = ['#007DFE', '#7C4DFF', '#00A884', '#F57C00', '#E91E63', '#0097A7', '#5C6BC0', '#8D6E63'];

export function Avatar({ name, size = 40 }: { name: string; size?: number }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('');
  const hash = [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.4, background: AVATAR_COLORS[hash % AVATAR_COLORS.length] }}>
      {initials || '?'}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Toasts + dialogs (replace alert / prompt / confirm)                 */
/* ------------------------------------------------------------------ */

type ToastKind = 'success' | 'error' | 'info';
interface Toast {
  id: number;
  text: string;
  kind: ToastKind;
}

export interface DialogField {
  name: string;
  label: string;
  type?: 'text' | 'password';
  value?: string;
  placeholder?: string;
}

interface DialogSpec {
  title: string;
  message?: ReactNode;
  fields?: DialogField[];
  confirmText?: string;
  cancelText?: string | null;
  danger?: boolean;
  /** Text the user can copy with one tap (e.g. new login details). */
  copyText?: string;
}

interface UiApi {
  toast: (text: string, kind?: ToastKind) => void;
  /** Resolves with the field values, or null if cancelled. */
  ask: (spec: DialogSpec) => Promise<Record<string, string> | null>;
  confirm: (spec: Omit<DialogSpec, 'fields'>) => Promise<boolean>;
  /** Simple message with an OK button. */
  info: (spec: Omit<DialogSpec, 'fields' | 'cancelText'>) => Promise<void>;
}

const UiContext = createContext<UiApi | null>(null);

export function useUi() {
  const ui = useContext(UiContext);
  if (!ui) throw new Error('useUi must be used inside <UiProvider>');
  return ui;
}

export function UiProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [dialog, setDialog] = useState<(DialogSpec & { resolve: (v: Record<string, string> | null) => void }) | null>(null);
  const nextId = useRef(1);

  const toast = useCallback((text: string, kind: ToastKind = 'success') => {
    const id = nextId.current++;
    setToasts((t) => [...t.slice(-2), { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 5000 : 2800);
  }, []);

  const ask = useCallback(
    (spec: DialogSpec) => new Promise<Record<string, string> | null>((resolve) => setDialog({ ...spec, resolve })),
    [],
  );
  const confirm = useCallback(async (spec: Omit<DialogSpec, 'fields'>) => (await ask({ ...spec, fields: [] })) !== null, [ask]);
  const info = useCallback(
    async (spec: Omit<DialogSpec, 'fields' | 'cancelText'>) => {
      await ask({ ...spec, fields: [], cancelText: null, confirmText: spec.confirmText ?? 'OK' });
    },
    [ask],
  );

  const api = useRef<UiApi>({ toast, ask, confirm, info });
  api.current = { toast, ask, confirm, info };

  return (
    <UiContext.Provider value={api.current}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.kind === 'success' && <Icon name="check" size={18} />}
            {t.text}
          </div>
        ))}
      </div>
      {dialog && (
        <Dialog
          spec={dialog}
          onClose={(v) => {
            dialog.resolve(v);
            setDialog(null);
          }}
          onCopied={() => toast('Copied')}
        />
      )}
    </UiContext.Provider>
  );
}

function Dialog({
  spec,
  onClose,
  onCopied,
}: {
  spec: DialogSpec;
  onClose: (v: Record<string, string> | null) => void;
  onCopied: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries((spec.fields ?? []).map((f) => [f.name, f.value ?? ''])),
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && spec.cancelText !== null && onClose(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, spec.cancelText]);

  return (
    <div className="sheet-backdrop" onClick={() => spec.cancelText !== null && onClose(null)}>
      <form
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={spec.title}
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          onClose(values);
        }}
      >
        <div className="sheet-handle" />
        <h2>{spec.title}</h2>
        {spec.message && <div className="sheet-message">{spec.message}</div>}
        {spec.copyText && (
          <button
            type="button"
            className="copy-box"
            onClick={() => navigator.clipboard?.writeText(spec.copyText ?? '').then(onCopied, () => undefined)}
          >
            <pre>{spec.copyText}</pre>
            <span>
              <Icon name="copy" size={18} /> Copy
            </span>
          </button>
        )}
        {(spec.fields ?? []).map((f, i) => {
          const common = {
            value: values[f.name],
            placeholder: f.placeholder,
            autoFocus: i === 0,
            required: true,
            onChange: (e: ChangeEvent<HTMLInputElement>) => setValues((v) => ({ ...v, [f.name]: e.target.value })),
          };
          return (
            <label key={f.name} className="field">
              <span className="label">{f.label}</span>
              {f.type === 'password' ? (
                <PasswordInput {...common} autoComplete="new-password" />
              ) : (
                <input {...common} className="input" autoComplete="off" />
              )}
            </label>
          );
        })}
        <div className="sheet-actions">
          {spec.cancelText !== null && (
            <button type="button" className="btn secondary" onClick={() => onClose(null)}>
              {spec.cancelText ?? 'Cancel'}
            </button>
          )}
          <button type="submit" className={`btn ${spec.danger ? 'danger-solid' : 'primary'}`}>
            {spec.confirmText ?? 'OK'}
          </button>
        </div>
      </form>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Action sheet (e.g. "Take photo / Choose from gallery")              */
/* ------------------------------------------------------------------ */

export function ActionSheet({
  title,
  actions,
  onClose,
}: {
  title?: string;
  actions: { icon: IconName; label: string; hint?: string; onClick: () => void }[];
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" />
        {title && <h2>{title}</h2>}
        {actions.map((a) => (
          <button
            key={a.label}
            className="sheet-action"
            onClick={() => {
              onClose();
              a.onClick();
            }}
          >
            <span className="sheet-action-icon">
              <Icon name={a.icon} />
            </span>
            <span>
              <strong>{a.label}</strong>
              {a.hint && <small>{a.hint}</small>}
            </span>
          </button>
        ))}
        <button className="btn secondary block" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Skeleton rows while loading                                         */
/* ------------------------------------------------------------------ */

export function SkeletonRows({ count = 4 }: { count?: number }) {
  return (
    <ul className="list" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <li key={i} className="row skeleton-row">
          <span className="thumb skeleton" />
          <span className="row-main">
            <span className="skeleton line w60" />
            <span className="skeleton line w40" />
          </span>
          <span className="skeleton line w20" />
        </li>
      ))}
    </ul>
  );
}

/** Small dismissible banner. Dismissals are remembered on this device. */
export function Banner({
  id,
  icon,
  children,
  action,
}: {
  id: string;
  icon: IconName;
  children: ReactNode;
  action?: { label: string; onClick: () => void; busy?: boolean };
}) {
  const key = `banner-dismissed:${id}`;
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(key) === '1';
    } catch {
      return false;
    }
  });
  if (hidden) return null;
  return (
    <div className="banner">
      <span className="banner-icon">
        <Icon name={icon} size={20} />
      </span>
      <span className="banner-text">{children}</span>
      {action && (
        <button className="banner-action" onClick={action.onClick} disabled={action.busy}>
          {action.busy ? '…' : action.label}
        </button>
      )}
      <button
        className="banner-close"
        aria-label="Dismiss"
        onClick={() => {
          setHidden(true);
          try {
            localStorage.setItem(key, '1');
          } catch {
            // ignore
          }
        }}
      >
        <Icon name="close" size={16} />
      </button>
    </div>
  );
}
