import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'

type Notice = { message: string; onDismiss: () => void; tone?: 'success' | 'error'; action?: ReactNode }

export default function Notifications({ items }: { items: Notice[] }) {
  return createPortal(<>
    {items.map(({ message, tone = 'error', onDismiss, action }, index) => message && <div key={index} role={tone === 'error' ? 'alert' : 'status'} className={`pointer-events-auto flex items-start gap-3 rounded-box border bg-base-100 p-3 text-sm shadow-lg ${tone === 'error' ? 'border-error/40' : 'border-success/40'}`}>
      <span aria-hidden="true" className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full ${tone === 'error' ? 'bg-error/10 text-error' : 'bg-success/10 text-success'}`}>{tone === 'error' ? '!' : '✓'}</span>
      <div className="min-w-0 flex-1"><p className="break-words">{message}</p>{action && <div className="mt-2">{action}</div>}</div>
      <button className="btn btn-ghost btn-square btn-sm shrink-0" type="button" aria-label="Dismiss notification" onClick={onDismiss}>
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="m6 6 12 12M18 6 6 18" /></svg>
      </button>
    </div>)}
  </>, document.getElementById('notifications')!)
}
