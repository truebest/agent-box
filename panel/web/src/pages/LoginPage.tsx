import { useEffect, useState, type FormEvent } from 'react'
import BusyButton from '../components/BusyButton'
import { signIn } from '../lib/auth'

export default function LoginPage({ sessionError }: { sessionError: string }) {
  const [visible, setVisible] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    const hide = () => setVisible(false)
    window.addEventListener('blur', hide)
    document.addEventListener('visibilitychange', hide)
    return () => { window.removeEventListener('blur', hide); document.removeEventListener('visibilitychange', hide) }
  }, [])
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (pending) return
    const form = event.currentTarget
    const username = form.elements.namedItem('username') as HTMLInputElement
    const password = form.elements.namedItem('password') as HTMLInputElement
    setPending(true)
    setError('')
    try { await signIn(username.value, password.value) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to sign in. Please try again.') }
    finally { password.value = ''; setVisible(false); setPending(false) }
  }
  return <main className="flex min-h-screen items-center justify-center bg-base-200 px-4 py-10 text-base-content">
    <section className="card w-full max-w-sm border border-base-300 bg-base-100 shadow-sm" aria-labelledby="login-title">
      <div className="card-body gap-6 p-6 sm:p-8">
        <header className="flex flex-col items-center gap-3 text-center">
          <img src="/logo.png" alt="Agent Box logo" className="h-12 w-12 object-contain" width="48" height="48" />
          <div><h1 id="login-title" className="text-xl font-semibold">Agent Box</h1>
            <p className="mt-1 text-sm text-base-content/70">Sign in to continue</p></div>
        </header>
        <form onSubmit={submit} className="flex flex-col gap-4" aria-label="Sign in">
          <label className="flex flex-col gap-2 text-sm font-medium" htmlFor="username">Username
            <input id="username" name="username" type="text" autoComplete="username" autoCapitalize="none" spellCheck={false}
              required maxLength={128} readOnly={pending} aria-describedby={error || sessionError ? 'login-error' : undefined}
              className="input input-bordered h-12 w-full font-normal" />
          </label>
          <div className="flex flex-col gap-2">
            <label htmlFor="password" className="text-sm font-medium">Password</label>
            <div className="input input-bordered flex h-12 w-full items-center gap-1 pr-1 focus-within:outline-2 focus-within:outline-offset-2"
              onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setVisible(false) }}>
              <input id="password" name="password" type={visible ? 'text' : 'password'} autoComplete="current-password"
                required maxLength={4096} readOnly={pending} aria-describedby={error || sessionError ? 'login-error' : undefined} className="min-w-0 grow" />
              <button type="button" aria-label={visible ? 'Hide password' : 'Show password'} aria-pressed={visible}
                className="btn btn-ghost btn-square min-h-11 h-11 w-11 shrink-0" disabled={pending} onClick={() => setVisible(value => !value)}>
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  {visible ? <><path d="m3 3 18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.7 5.2A11 11 0 0 1 12 5c5.5 0 9 7 9 7a17 17 0 0 1-3 3.9M6.5 6.5C4.3 8.2 3 12 3 12s3.5 7 9 7a10 10 0 0 0 4.3-1" /></> : <><path d="M3 12s3.5-7 9-7 9 7 9 7-3.5 7-9 7-9-7-9-7Z" /><circle cx="12" cy="12" r="3" /></>}
                </svg>
              </button>
            </div>
          </div>
          <p id="login-error" role="alert" className="min-h-10 text-sm text-error">{error || sessionError}</p>
          <BusyButton type="submit" className="btn-neutral mt-1 h-12 w-full" busy={pending}>Sign in</BusyButton>
        </form>
      </div>
    </section>
  </main>
}
