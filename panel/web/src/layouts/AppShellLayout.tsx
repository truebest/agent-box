// Adapted from agent-sandbox/agent-sandbox AppShellLayout (Apache-2.0).
import { useEffect, useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import Notifications from '../components/Notifications'
import { applyTheme, getAvailableThemes, getTheme, type ThemeName } from '../lib/theme/theme'
import { signOut } from '../lib/auth'

const links = [['/sandboxes', 'Sandboxes'], ['/workers', 'Workers'], ['/terminal', 'Terminal'], ['/files', 'Files'], ['/tasks', 'Tasks']]

export default function AppShellLayout() {
  const [theme, setTheme] = useState<ThemeName>(getTheme())
  const [consoleEnabled, setConsoleEnabled] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  const [signOutError, setSignOutError] = useState('')
  const exit = async () => {
    setSigningOut(true)
    setSignOutError('')
    try { await signOut() }
    catch { setSignOutError('Unable to sign out. Please try again.') }
    finally { setSigningOut(false) }
  }
  useEffect(() => {
    const controller = new AbortController()
    void fetch('/api/console', { signal: controller.signal, credentials: 'same-origin' })
      .then((response) => response.ok ? response.json() : null)
      .then((data) => setConsoleEnabled(data?.enabled === true)).catch(() => {})
    return () => controller.abort()
  }, [])
  const navigation = (consoleEnabled ? [...links, ['/console', 'Superterminal']] : links).map(([path, title]) => <li key={path}>
    <NavLink to={path} className={({ isActive }) => isActive ? 'menu-active text-left' : 'text-left'}>{title}</NavLink>
  </li>)
  return (
    <div className="h-screen bg-base-200 text-base-content">
      <div className="mx-auto flex h-full w-full gap-6 p-4 lg:p-6">
        <aside className="sticky top-4 hidden h-[calc(100vh-2rem)] w-[230px] shrink-0 flex-col p-4 lg:flex">
          <div className="mb-4 flex items-center gap-3">
            <img src="./logo.png" alt="Agent Box logo" className="h-8 w-7 rounded" />
            <h1 className="text-lg font-semibold">Agent Box</h1>
          </div>
          <ul className="menu w-full p-0">{navigation}</ul>
          <div className="mt-auto space-y-3">
            <label className="flex items-center gap-2 text-xs">Theme
              <select aria-label="Theme" className="select select-bordered select-xs" value={theme}
                onChange={(event) => { const next = event.target.value as ThemeName; setTheme(next); applyTheme(next) }}>
                {getAvailableThemes().map((item) => <option key={item}>{item}</option>)}
              </select>
            </label>
            <p className="text-xs text-base-content/70">Signed in as admin</p>
            <button type="button" className="btn btn-ghost btn-sm w-full justify-start" disabled={signingOut} onClick={() => void exit()}>Sign out</button>
            <a className="link text-xs" href="https://github.com/agent-sandbox/agent-sandbox/tree/6f7b273ea80732b063d1d1a914b7138780fa83a0/ui" target="_blank" rel="noreferrer">UI credits · Apache-2.0</a>
          </div>
        </aside>
        <main className="custom-scrollbar min-h-0 min-w-0 flex-1 space-y-3 overflow-y-auto">
          <nav aria-label="Navigation" className="flex flex-wrap items-center gap-2 lg:hidden"><ul className="menu menu-horizontal rounded-box bg-base-100">{navigation}</ul><button type="button" className="btn btn-ghost btn-sm" disabled={signingOut} onClick={() => void exit()}>Sign out</button></nav>
          <Notifications items={[{ message: signOutError, onDismiss: () => setSignOutError('') }]} />
          <Outlet />
        </main>
      </div>
    </div>
  )
}
