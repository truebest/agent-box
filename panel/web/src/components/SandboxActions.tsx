import { useEffect, useId, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Sandbox } from '../lib/api/types'

const icons = {
  open: <path d="M7 17 17 7M7 7h10v10" />,
  terminal: <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="m7 9 3 3-3 3m6 0h4" /></>,
  files: <path d="M3 7a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />,
  more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
  suspend: <path d="M8 5v14M16 5v14" />,
  resume: <path d="m8 5 11 7-11 7Z" />,
  revert: <path d="M3 10a9 9 0 1 1 2 8M3 4v6h6M12 7v5l3 2" />,
  task: <path d="m21 3-7 18-4-7-7-4ZM10 14 21 3" />,
  delete: <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" />,
}

function Icon({ name }: { name: keyof typeof icons }) {
  return <svg aria-hidden="true" className="size-[18px] shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{icons[name]}</svg>
}

export default function SandboxActions({ sandbox, disabled, pendingOperation, onOpen, onOperation, onDelete }: {
  sandbox: Sandbox
  disabled: boolean
  pendingOperation: string
  onOpen: () => void
  onOperation: (operation: 'suspend' | 'resume' | 'revert') => void
  onDelete: () => void
}) {
  const navigate = useNavigate()
  const id = useId()
  const menu = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const running = sandbox.status === 'running'
  const suspended = sandbox.status === 'suspended'
  const unavailable = !sandbox.name || !sandbox.id || disabled

  useEffect(() => {
    if (!open) return
    const close = () => menu.current?.hidePopover()
    window.addEventListener('resize', close)
    document.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('resize', close)
      document.removeEventListener('scroll', close, true)
    }
  }, [open])

  return <div className="flex items-center justify-end gap-1 whitespace-nowrap" role="group" aria-label={`Actions for ${sandbox.name}`} aria-busy={Boolean(pendingOperation)}>
    {(running || suspended) && <button className="btn btn-soft btn-primary btn-square min-h-11 min-w-11" type="button" aria-label={running ? 'Suspend sandbox' : 'Resume sandbox'} title={running ? 'Suspend sandbox' : 'Resume sandbox'} disabled={unavailable} onClick={() => onOperation(running ? 'suspend' : 'resume')}>
      {['suspend', 'resume'].includes(pendingOperation) ? <span className="loading loading-spinner loading-xs" /> : <Icon name={running ? 'suspend' : 'resume'} />}
    </button>}
    {(['terminal', 'files'] as const).map(action => <button key={action} className="btn btn-ghost btn-square min-h-11 min-w-11 text-base-content/70" type="button" aria-label={action === 'terminal' ? 'Terminal' : 'Files'} title={action === 'terminal' ? 'Terminal' : 'Files'} disabled={unavailable} onClick={() => navigate(`/${action}?sandbox=${encodeURIComponent(sandbox.name || '')}`)}><Icon name={action} /></button>)}
    <button ref={trigger} popoverTarget={id} className="btn btn-ghost btn-square min-h-11 min-w-11 text-base-content/70" type="button" aria-label={`Manage ${sandbox.name}`} title="Manage sandbox" aria-haspopup="menu" aria-expanded={open} aria-controls={id} disabled={unavailable} onKeyDown={event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); menu.current?.showPopover() }
    }}>{pendingOperation === 'delete' ? <span className="loading loading-spinner loading-xs" /> : <Icon name="more" />}</button>
    <div ref={menu} id={id} popover="auto" role="menu" aria-label={`Manage ${sandbox.name}`} className="fixed inset-auto m-0 max-h-[calc(100dvh-1rem)] w-60 overflow-y-auto whitespace-normal rounded-box border border-base-300 bg-base-100 p-1.5 text-base-content shadow-xl" onBeforeToggle={event => {
      if (event.newState !== 'open') return
      event.currentTarget.style.visibility = 'hidden'
      requestAnimationFrame(() => {
        const element = menu.current, button = trigger.current
        if (!element?.matches(':popover-open') || !button) return
        const anchor = button.getBoundingClientRect(), bounds = element.getBoundingClientRect()
        element.style.left = `${Math.max(8, Math.min(anchor.right - bounds.width, window.innerWidth - bounds.width - 8))}px`
        element.style.top = `${Math.max(8, anchor.bottom + bounds.height + 8 <= window.innerHeight ? anchor.bottom + 6 : anchor.top - bounds.height - 6)}px`
        element.style.visibility = 'visible'
        element.querySelector('button')?.focus()
      })
    }} onToggle={event => setOpen(event.newState === 'open')} onClick={event => {
      if ((event.target as HTMLElement).closest('button')) { menu.current?.hidePopover(); trigger.current?.focus() }
    }} onKeyDown={event => {
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault()
        buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus()
      } else if (event.key === 'Escape' || event.key === 'Tab') {
        menu.current?.hidePopover()
        trigger.current?.focus()
        if (event.key === 'Escape') event.preventDefault()
      }
    }}>
      {(running || suspended) && sandbox.id && <button role="menuitem" className="btn btn-ghost w-full justify-start" type="button" disabled={unavailable} onClick={onOpen}><Icon name="open" />{suspended ? 'Resume & open' : 'Open Superterminal'}</button>}
      {running && sandbox.primaryReady === true && <button role="menuitem" className="btn btn-ghost w-full justify-start" type="button" disabled={unavailable} onClick={() => navigate(`/tasks?sandbox=${encodeURIComponent(sandbox.name || '')}&uid=${encodeURIComponent(sandbox.id || '')}`)}><Icon name="task" />Send task</button>}
      {(['suspend', 'resume', 'revert'] as const).filter(operation => operation === 'suspend' ? running : operation === 'resume' ? suspended : sandbox.status === 'crashed' && sandbox.hasSnapshot).map(operation => <button key={operation} role="menuitem" className="btn btn-ghost w-full justify-start" type="button" disabled={unavailable} onClick={() => onOperation(operation)}><Icon name={operation} />{operation === 'suspend' ? 'Suspend' : operation === 'resume' ? 'Resume' : 'Restore snapshot'}</button>)}
      <div role="separator" className="my-1 border-t border-base-300" />
      <button role="menuitem" className="btn btn-ghost w-full justify-start text-error" type="button" disabled={unavailable} onClick={onDelete}><Icon name="delete" />Delete sandbox…</button>
    </div>
  </div>
}
