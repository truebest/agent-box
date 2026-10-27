export const AUTH_EVENT = 'agent-box:auth'
export const LOGOUT_KEY = 'agent-box:logout'
export type BrowserSession = { authenticated: boolean; expires_at?: string }

const channel = (() => {
  try { return typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('agent-box-auth') }
  catch { return null }
})()
const draftKey = /(?:^|:)herdr-web-ui:(?:composer-draft|composer-sending|terminal-draft|terminal-line|pending):/

export function authRequired(): void {
  window.dispatchEvent(new CustomEvent(AUTH_EVENT, { detail: 'expired' }))
}

export function clearBrowserDrafts(): void {
  for (const name of ['localStorage', 'sessionStorage'] as const) {
    try {
      const storage = window[name]
      for (let index = storage.length - 1; index >= 0; index--) {
        const key = storage.key(index)
        if (key && draftKey.test(key)) storage.removeItem(key)
      }
    } catch { /* Unavailable browser storage cannot retain these drafts. */ }
  }
}

export async function readSession(signal?: AbortSignal): Promise<BrowserSession> {
  const timeout = AbortSignal.timeout(15_000)
  const response = await fetch('/api/auth/session', { credentials: 'same-origin', cache: 'no-store', signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
  if (!response.ok) throw new Error('Unable to check your session. Please try again.')
  const session = await response.json() as BrowserSession
  if (typeof session.authenticated !== 'boolean' || (session.authenticated && !Number.isFinite(Date.parse(session.expires_at || '')))) {
    throw new Error('Unable to check your session. Please try again.')
  }
  return session
}

export async function signIn(username: string, password: string): Promise<void> {
  const response = await fetch('/api/auth/login', {
    method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }), signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) {
    if (response.status === 401) throw new Error('Invalid username or password.')
    if (response.status === 429) throw new Error('Too many sign-in attempts. Try again in a minute.')
    throw new Error('Sign in is temporarily unavailable. Please try again.')
  }
  window.dispatchEvent(new CustomEvent(AUTH_EVENT, { detail: 'refresh' }))
}

export async function signOut(): Promise<void> {
  const response = await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin', signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error('Unable to sign out. Please try again.')
  try { localStorage.setItem(LOGOUT_KEY, crypto.randomUUID()) } catch { /* BroadcastChannel covers storage-disabled tabs. */ }
  channel?.postMessage('logout')
  window.dispatchEvent(new CustomEvent(AUTH_EVENT, { detail: 'logout' }))
}

if (channel) channel.onmessage = event => {
  if (event.data === 'logout') window.dispatchEvent(new CustomEvent(AUTH_EVENT, { detail: 'logout' }))
}
