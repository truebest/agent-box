import type { ButtonHTMLAttributes } from 'react'

export default function BusyButton({ busy, children, className = '', disabled, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { busy: boolean }) {
  return <button {...props} className={`btn relative ${className}`} disabled={busy || disabled} aria-busy={busy}>
    <span className={busy ? 'opacity-0' : ''}>{children}</span>
    {busy && <span className="loading loading-spinner loading-xs absolute" aria-hidden="true" />}
  </button>
}
