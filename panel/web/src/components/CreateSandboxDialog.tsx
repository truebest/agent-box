import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import BusyButton from './BusyButton'
import { agentPath, createSandbox, CreateSandboxError } from '../lib/api/sandbox'
import { request } from '../lib/api/http'
import { listWorkerProfiles, profileSummary, type WorkerProfile } from '../lib/api/workers'
import type { Actor, AgentKind, CreateEvent } from '../lib/api/types'

const models = [
  { id: 'gpt-6-luna', name: 'GPT-6 Luna' },
  { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' },
  { id: 'gpt-6-astra', name: 'GPT-6 Astra' },
]
const generateName = () => `sandbox-${crypto.randomUUID().slice(0, 8)}`

export default function CreateSandboxDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (actor: Actor, kind: AgentKind) => void }) {
  const navigate = useNavigate()
  const dialog = useRef<HTMLDialogElement>(null)
  const inFlight = useRef(false)
  const controller = useRef<AbortController | null>(null)
  const [name, setName] = useState(generateName)
  const [profiles, setProfiles] = useState<WorkerProfile[]>([])
  const [profileID, setProfileID] = useState('')
  const [profilesReady, setProfilesReady] = useState(false)
  const [kind, setKind] = useState<AgentKind>('codex')
  const [model, setModel] = useState('gpt-6.1-sol')
  const [cwd, setCwd] = useState('/workspace')
  const [prompt, setPrompt] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [uncertain, setUncertain] = useState(false)
  const [resource, setResource] = useState<Actor>()
  const [progress, setProgress] = useState<Partial<Record<string, string>>>({})
  const custom = !models.some(item => item.id === model)
  const locked = pending || uncertain || Boolean(resource)
  useEffect(() => {
    const modal = dialog.current
    modal?.showModal()
    return () => { controller.current?.abort(); modal?.close() }
  }, [])
  useEffect(() => {
    const abort = new AbortController()
    void listWorkerProfiles(abort.signal).then(catalog => {
      if (abort.signal.aborted) return
      setProfiles(catalog.profiles.filter(profile => profile.enabled)); setProfileID(catalog.default_id || ''); setProfilesReady(true)
    }).catch(cause => { if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : 'Unable to load profiles') })
    return () => abort.abort()
  }, [])
  const openResource = (actor: Actor) => {
    onClose()
    navigate(kind === 'none' ? `/terminal?sandbox=${encodeURIComponent(actor.metadata.name)}&uid=${encodeURIComponent(actor.metadata.uid || '')}` : `/console?uid=${encodeURIComponent(actor.metadata.uid || '')}`)
  }
  const check = async () => {
    try {
      const actor: Actor = await (await request(agentPath(name))).json()
      setResource(actor)
      setError('The sandbox exists. Open it to inspect the agent and prompt delivery. Creation will not be repeated.')
    } catch { setError('Status is not confirmed yet. Check again before creating another sandbox.') }
  }
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (inFlight.current || locked || !profilesReady) return
    inFlight.current = true
    setPending(true); setError(''); setProgress({})
    controller.current = new AbortController()
    try {
      const actor = await createSandbox({ name: name.trim(), ...(profileID ? { profile_id: profileID } : {}), kind, ...(kind === 'none' ? {} : { model: model.trim(), cwd: cwd.trim(), ...(prompt.trim() ? { prompt } : {}) }) }, (event: CreateEvent) => {
        if (event.stage) setProgress(previous => ({ ...previous, [event.stage!]: event.status || 'running' }))
      }, controller.current.signal)
      onCreated(actor, kind)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to create sandbox')
      if (cause instanceof CreateSandboxError) { setResource(cause.actor); setUncertain(cause.uncertain) }
    } finally { inFlight.current = false; setPending(false) }
  }
  const steps = [{ id: 'sandbox', label: 'Create and start sandbox' }, ...(kind === 'none' ? [] : [{ id: 'agent', label: `Prepare ${kind === 'codex' ? 'Codex' : kind === 'devin' ? 'Devin CLI' : 'Pi'}` }]), ...(kind !== 'none' && prompt.trim() ? [{ id: 'prompt', label: 'Send initial prompt' }] : [])]
  return <dialog ref={dialog} className="modal" aria-labelledby="create-title" onCancel={event => { event.preventDefault(); if (!pending) onClose() }} onClick={event => { if (event.target === event.currentTarget && !pending) onClose() }}>
    <div className="modal-box w-[calc(100%_-_2rem)] max-w-lg border border-base-300 p-6 sm:p-8">
      <header className="mb-6"><h3 id="create-title" className="text-xl font-semibold">Create Sandbox</h3><p className="mt-1 text-sm text-base-content/70">Create an isolated workspace, with or without an agent.</p></header>
      <form onSubmit={event => void submit(event)} className="space-y-5" aria-busy={pending}>
        <fieldset disabled={locked} className="space-y-5">
          <label className="flex flex-col gap-2 text-sm font-medium">Name
            <span className="input input-bordered flex h-12 w-full items-center gap-1 pr-1">
              <input autoFocus aria-label="Name" name="name" className="min-w-0 grow font-normal" value={name} required maxLength={50} pattern="[a-z](?:[a-z0-9]|-){0,48}[a-z0-9]" autoComplete="off" spellCheck={false} onChange={event => setName(event.target.value)} />
              <button type="button" className="btn btn-ghost btn-square h-11 min-h-11 w-11" aria-label="Generate another name" title="Generate another name" onClick={() => setName(generateName())}>
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 7h-5M20 7V2M4 17h5M4 17v5M20 7a9 9 0 0 0-15-2M4 17a9 9 0 0 0 15 2" /></svg>
              </button>
            </span>
            <span className="text-xs font-normal text-base-content/60">Generated automatically. You can change it.</span>
          </label>
          {(!profilesReady || profiles.length > 0) && <label className="flex flex-col gap-2 text-sm font-medium">Worker profile
            <select aria-label="Worker profile" className="select select-bordered h-12 w-full" required disabled={!profilesReady} value={profileID} onChange={event => setProfileID(event.target.value)}>
              {!profilesReady && <option value="">Loading profiles…</option>}
              {profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}{profile.default ? ' (default)' : ''}</option>)}
            </select>
            <span className="text-xs font-normal text-base-content/60">{profiles.find(profile => profile.id === profileID) && profileSummary(profiles.find(profile => profile.id === profileID)!)} · Worker selected automatically</span>
          </label>}
          <label className="flex flex-col gap-2 text-sm font-medium">Agent
            <select aria-label="Agent" name="kind" className="select select-bordered h-12 w-full font-normal" value={kind} onChange={event => { const next = event.target.value as AgentKind; setKind(next); setModel(next === 'devin' ? '' : 'gpt-6.1-sol') }}>
              <option value="codex">Codex</option><option value="pi">Pi</option><option value="devin">Devin CLI</option><option value="none">No agent</option>
            </select>
          </label>
          {kind === 'none' ? <p className="rounded-box bg-base-200 p-4 text-sm text-base-content/70">Create the workspace now. Add agents later in Superterminal.</p> : <div className="space-y-5">
            {kind === 'devin' ? <label className="flex flex-col gap-2 text-sm font-medium">Model ID
              <input aria-label="Model ID" className="input input-bordered h-12 w-full font-normal" value={model} maxLength={128} placeholder="Devin CLI default" onChange={event => setModel(event.target.value)} />
              <span className="text-xs font-normal text-base-content/60">Optional. Sign in and complete first-time setup in Superterminal.</span>
            </label> : <label className="flex flex-col gap-2 text-sm font-medium">Model
              <select aria-label="Model" className="select select-bordered h-12 w-full font-normal" value={custom ? '' : model} onChange={event => setModel(event.target.value)}>
                {models.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}<option value="">Other model…</option>
              </select>
            </label>}
            {kind !== 'devin' && custom && <label className="flex flex-col gap-2 text-sm font-medium">Model ID<input className="input input-bordered h-12 w-full font-normal" value={model} required maxLength={128} onChange={event => setModel(event.target.value)} /></label>}
            <label className="flex flex-col gap-2 text-sm font-medium">Initial prompt <span className="-mt-1 text-xs font-normal text-base-content/60">Optional. Sent once after the agent is ready.</span>
              <textarea aria-label="Initial prompt" className="textarea textarea-bordered min-h-28 w-full resize-y font-normal" value={prompt} maxLength={65536} placeholder="What should the agent work on?" onChange={event => setPrompt(event.target.value)} />
            </label>
            <details className="rounded-box border border-base-300"><summary className="cursor-pointer px-4 py-3 text-sm font-medium">Advanced</summary>
              <label className="flex flex-col gap-2 px-4 pb-4 text-sm font-medium">Directory<input aria-label="Directory" className="input input-bordered h-12 w-full font-normal" required maxLength={4096} pattern="/workspace(/.*)?" value={cwd} onChange={event => setCwd(event.target.value)} /><span className="text-xs font-normal text-base-content/60">Inside /workspace. Missing folders are created.</span></label>
            </details>
          </div>}
        </fieldset>
        <ol className="space-y-3 rounded-box bg-base-200 p-4" aria-label="Creation progress" aria-live="polite">
          {steps.map(step => <li key={step.id} className="flex items-center gap-3 text-sm" data-stage={step.id} data-status={progress[step.id] || 'pending'}>
            {progress[step.id] === 'running' ? <span className="loading loading-spinner size-4 shrink-0" aria-hidden="true" /> : <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border text-xs ${progress[step.id] === 'done' ? 'border-success text-success' : progress[step.id] === 'failed' ? 'border-error text-error' : 'border-base-content/30'}`} aria-hidden="true">{progress[step.id] === 'done' ? '✓' : progress[step.id] === 'failed' ? '×' : ''}</span>}
            <span>{step.label}<span className="sr-only">: {progress[step.id] || 'pending'}</span></span>
          </li>)}
        </ol>
        <p role="status" className={`text-xs text-base-content/60 ${pending ? '' : 'invisible'}`}>Creation continues if you close this tab.</p>
        {error && <div role="alert" className="rounded-box border border-error/30 bg-error/5 p-4 text-sm text-error">{error}</div>}
        <div className="flex flex-wrap justify-end gap-2 border-t border-base-300 pt-5">
          <button className="btn btn-ghost" type="button" disabled={pending} onClick={onClose}>{resource || uncertain ? 'Close' : 'Cancel'}</button>
          {resource ? <button className="btn btn-primary" type="button" onClick={() => openResource(resource)}>Open sandbox</button> : uncertain ? <button className="btn btn-primary" type="button" onClick={() => void check()}>Check status</button> : <BusyButton className="btn-primary min-w-36" type="submit" busy={pending} disabled={!profilesReady}>Create Sandbox</BusyButton>}
        </div>
      </form>
    </div>
  </dialog>
}
