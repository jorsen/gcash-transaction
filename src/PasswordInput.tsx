import { useState, type InputHTMLAttributes } from 'react';

/** Password field with a show/hide (eye) toggle. */
export function PasswordInput(props: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  const [show, setShow] = useState(false);
  return (
    <span className="password-wrap">
      <input {...props} type={show ? 'text' : 'password'} className={`input ${props.className ?? ''}`} />
      <button
        type="button"
        className="eye-btn"
        aria-label={show ? 'Hide password' : 'Show password'}
        aria-pressed={show}
        onClick={() => setShow((s) => !s)}
      >
        {show ? (
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <path fill="currentColor" d="M2.1 3.5 3.5 2.1l18.4 18.4-1.4 1.4-3.2-3.2A10.9 10.9 0 0 1 12 20C6.5 20 2.7 15.9 1 12a12.6 12.6 0 0 1 4-5.1L2.1 3.5ZM12 4c5.5 0 9.3 4.1 11 8a12.7 12.7 0 0 1-3.3 4.6l-2.9-2.9A5 5 0 0 0 10.3 7.2L7.9 4.8A11 11 0 0 1 12 4Zm-3.9 5.5 6.4 6.4A5 5 0 0 1 8.1 9.5Z" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <path fill="currentColor" d="M12 4c5.5 0 9.3 4.1 11 8-1.7 3.9-5.5 8-11 8S2.7 15.9 1 12c1.7-3.9 5.5-8 11-8Zm0 3a5 5 0 1 0 0 10 5 5 0 0 0 0-10Zm0 2.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5Z" />
          </svg>
        )}
      </button>
    </span>
  );
}
