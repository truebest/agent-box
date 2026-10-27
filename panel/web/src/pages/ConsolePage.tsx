import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { HttpError, request } from '../lib/api/http'
import { authRequired } from '../lib/auth'

type Sandbox = { host: string; name: string; uid: string; kind: string; sandbox: string; runner: string; worker: string; error?: string }
type Worker = { host: string; id: string; name: string; state: string; agents: number; capacity: Record<string, string>; allocated: Record<string, string> }
type Pool = { enabled: boolean; hosts: { id: string; name: string }[]; workers: Worker[]; agents: Sandbox[] }

function agentPath(agent: Pick<Sandbox, 'name' | 'uid'>) {
  return `/api/console/agents/${encodeURIComponent(agent.name)}/${encodeURIComponent(agent.uid)}`
}

export default function ConsolePage() {
  const [search, setSearch] = useSearchParams()
  const [pool, setPool] = useState<Pool | null>(null)
  const [error, setError] = useState('')
  const [connectionError, setConnectionError] = useState('')
  const [connectedUID, setConnectedUID] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [resuming, setResuming] = useState<string[]>([])
  const resumeRequests = useRef(new Set<string>())
  const inventoryEpoch = useRef(0)
  const [retry, setRetry] = useState(0)
  const [host, setHost] = useState('')
  const [worker, setWorker] = useState('')
  const [appearance, setAppearance] = useState({ backgroundColor: 'var(--color-base-100)', color: 'var(--color-base-content)', colorScheme: 'inherit' })
  const frame = useRef<HTMLIFrameElement>(null)
  const uid = search.get('uid') || ''
  const selectedUID = useRef(uid)
  selectedUID.current = uid
  const selected = pool?.agents.find((agent) => agent.uid === uid)
  const selectedHost = selected?.host
  const isResuming = resuming.includes(uid)
  const pending = connecting || isResuming

  useEffect(() => { setConnectionError('') }, [uid, selected?.sandbox])

  useEffect(() => {
    if (selectedHost) { setHost(selectedHost); setWorker('') }
  }, [selectedHost])

  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      const epoch = inventoryEpoch.current
      try {
        const next: Pool = await (await request('/api/console')).json()
        if (!stopped && epoch === inventoryEpoch.current) { setPool(next); setError('') }
      } catch (cause) {
        if (!stopped && epoch === inventoryEpoch.current) setError(cause instanceof Error ? cause.message : String(cause))
      }
      if (!stopped) timer = setTimeout(() => void poll(), 5000)
    }
    void poll()
    return () => { stopped = true; clearTimeout(timer) }
  }, [retry])

  const name = selected?.name
  const sandbox = selected?.sandbox
  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    setConnectedUID('')
    setConnecting(false)
    if (!name || sandbox !== 'RUNNING' || isResuming) return
    setConnectionError('')
    setConnecting(true)
    const connect = async (attempt: number) => {
      try {
        await request(`${agentPath({ name, uid })}/connect`, { method: 'POST', operation: true })
        if (!stopped) { setConnectedUID(uid); setConnecting(false) }
      } catch (cause) {
        if (stopped) return
        if (attempt < 4 && (!(cause instanceof HttpError) || [408, 429, 500, 502, 503, 504].includes(cause.status))) {
          timer = setTimeout(() => void connect(attempt + 1), 1000 * 2 ** attempt)
          return
        }
        setConnectionError(cause instanceof Error ? cause.message : String(cause))
        setConnecting(false)
      }
    }
    void connect(0)
    return () => { stopped = true; clearTimeout(timer) }
  }, [uid, name, sandbox, retry, isResuming])

  const resume = useCallback(async (agent: Sandbox) => {
    if (resumeRequests.current.has(agent.uid)) return
    resumeRequests.current.add(agent.uid)
    setResuming(previous => [...previous, agent.uid])
    setConnectionError('')
    try {
      await request(`${agentPath(agent)}/resume`, { method: 'POST', operation: true })
      inventoryEpoch.current++
      setPool(previous => previous ? { ...previous, agents: previous.agents.map(item => item.uid === agent.uid ? { ...item, sandbox: 'RUNNING' } : item) } : previous)
      if (selectedUID.current === agent.uid) setRetry(value => value + 1)
    } catch (cause) { if (selectedUID.current === agent.uid) setConnectionError(cause instanceof Error ? cause.message : String(cause)) }
    finally {
      resumeRequests.current.delete(agent.uid)
      setResuming(previous => previous.filter(value => value !== agent.uid))
    }
  }, [])

  const state = useMemo(() => ({ type: 'console-state', pool, uid, host, worker, error, connectionError, connectedUID, pending }), [pool, uid, host, worker, error, connectionError, connectedUID, pending])
  useEffect(() => {
    const send = () => frame.current?.contentWindow?.postMessage(state, window.location.origin)
    const receive = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== frame.current?.contentWindow) return
      const message = event.data
      if (!message || typeof message !== 'object') return
      if (message.type === 'console-auth-required') authRequired()
      if (message.type === 'console-ready') {
        if (typeof message.background === 'string' && typeof message.color === 'string' && CSS.supports('background-color', message.background) && CSS.supports('color', message.color) && ['dark', 'light'].includes(message.colorScheme)) {
          setAppearance({ backgroundColor: message.background, color: message.color, colorScheme: message.colorScheme })
        }
        if (frame.current) frame.current.dataset.ready = 'true'
        send()
      }
      if (message.type === 'console-select' && pool?.agents.some((agent) => agent.uid === message.uid && agent.host === message.host)) setSearch({ uid: message.uid })
      if (message.type === 'console-worker' && pool?.hosts.some((item) => item.id === message.host) && (message.worker === '' || pool.workers.some((item) => item.id === message.worker && item.host === message.host))) { setHost(message.host); setWorker(message.worker) }
      if (message.type === 'console-resume' && !pending && selected && selected.uid === message.uid && selected.host === message.host && selected.sandbox === 'SUSPENDED') void resume(selected)
      if (message.type === 'console-retry' && !pending) setRetry((value) => value + 1)
    }
    window.addEventListener('message', receive)
    send()
    return () => window.removeEventListener('message', receive)
  }, [state, pool, setSearch, selected, pending, resume])

  return <section className="superterminal-page flex min-h-0 flex-1 flex-col gap-3" aria-label="Superterminal">
    <h2 className="text-2xl font-semibold">Superterminal</h2>
    {pool?.enabled === false ? <p role="status">Superterminal is awaiting compatibility verification.</p> :
      <div className="superterminal-surface min-h-0 flex-1 overflow-hidden rounded-box" style={appearance}>
        <div className="superterminal-loading flex-col gap-3" role="status">
          <p>{connectionError || error || (uid ? 'Opening sandbox…' : 'Loading Superterminal…')}</p>
          {(connectionError || error) && <button className="btn btn-sm btn-neutral" disabled={pending} onClick={() => {
            frame.current?.contentWindow?.location.reload()
            setRetry((value) => value + 1)
          }}>Retry</button>}
        </div>
        <iframe ref={frame} title="Superterminal navigation" className="superterminal-frame h-full w-full border-0"
          src="/api/console/ui/" onLoad={() => frame.current?.contentWindow?.postMessage(state, window.location.origin)} />
      </div>}
  </section>
}
