import { useEffect, useState, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { AUTH_EVENT, LOGOUT_KEY, authRequired, clearBrowserDrafts, readSession, type BrowserSession } from '../lib/auth'
import LoginPage from '../pages/LoginPage'

export default function AuthGate({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<BrowserSession | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    let revision = 0
    const check = async () => {
      const current = ++revision
      try {
        const next = await readSession(controller.signal)
        if (current === revision && !controller.signal.aborted) { setSession(next); setError('') }
      } catch {
        if (current === revision && !controller.signal.aborted) {
          setSession(previous => previous || { authenticated: false })
          setError('Unable to check your session. Please try again.')
        }
      }
    }
    const invalidate = (event: Event) => {
      const reason = (event as CustomEvent<string>).detail
      if (reason === 'refresh' || reason === 'expired') { void check(); return }
      revision++
      flushSync(() => { setSession({ authenticated: false }); setError('') })
      if (reason === 'logout') clearBrowserDrafts()
    }
    const changed = (event: StorageEvent) => {
      if (event.key === LOGOUT_KEY && event.newValue) invalidate(new CustomEvent(AUTH_EVENT, { detail: 'logout' }))
    }
    const focused = () => { if (document.visibilityState === 'visible') void check() }
    window.addEventListener(AUTH_EVENT, invalidate)
    window.addEventListener('storage', changed)
    window.addEventListener('focus', focused)
    document.addEventListener('visibilitychange', focused)
    const timer = window.setInterval(() => void check(), 60_000)
    void check()
    return () => {
      revision++
      controller.abort()
      window.clearInterval(timer)
      window.removeEventListener(AUTH_EVENT, invalidate)
      window.removeEventListener('storage', changed)
      window.removeEventListener('focus', focused)
      document.removeEventListener('visibilitychange', focused)
    }
  }, [])
  useEffect(() => {
    if (!session?.authenticated) return
    const timer = window.setTimeout(authRequired, Math.max(0, Date.parse(session.expires_at || '') - Date.now()))
    return () => window.clearTimeout(timer)
  }, [session])
  if (!session) return <div className="flex min-h-screen items-center justify-center bg-base-200 text-base-content" role="status">Loading…</div>
  return session.authenticated ? children : <LoginPage sessionError={error} />
}
