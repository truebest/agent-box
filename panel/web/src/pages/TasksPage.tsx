import { useEffect, useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import BusyButton from '../components/BusyButton'
import Notifications from '../components/Notifications'
import { request } from '../lib/api/http'
import { agentRuntimePath, listSandboxes } from '../lib/api/sandbox'
import type { Sandbox } from '../lib/api/types'

export default function TasksPage() {
  const [query, setQuery] = useSearchParams()
  const selected = query.get('sandbox') || ''
  const uid = query.get('uid') || ''
  const [sandboxes, setSandboxes] = useState<Sandbox[]>([])
  const [output, setOutput] = useState('')
  const [error, setError] = useState('')
  const selectedSandbox = sandboxes.find(sandbox => sandbox.name === selected && sandbox.id === uid)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const abort = new AbortController()
    listSandboxes(abort.signal).then(list => {
      if (abort.signal.aborted) return
      setSandboxes(list)
      const target = list.find(sandbox => sandbox.name === selected)
      if (!uid && target?.id) setQuery({ sandbox: selected, uid: target.id }, { replace: true })
    }).catch((e: Error) => { if (!abort.signal.aborted) setError(e.message) })
    return () => abort.abort()
  }, [selected, uid, setQuery])
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selectedSandbox) return
    const form = new FormData(event.currentTarget)
    const prompt = String(form.get('prompt'))
    setBusy(true); setError(''); setOutput('Sending…')
    try {
      const result: { accepted: boolean; message: string } = await (await request(agentRuntimePath(selected, uid, 'prompt'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt }),
      })).json()
      setOutput(result.message)
    } catch (e) { setError(e instanceof Error ? `Delivery may be uncertain. Read agent state and history in Superterminal before sending again. ${e.message}` : 'Delivery uncertain; read agent state and history in Superterminal before sending again.') }
    finally { setBusy(false) }
  }
  return <>
    <header className="card border border-base-300 bg-base-100 shadow-sm"><div className="card-body">
      <h2 className="text-2xl font-semibold">Agent Tasks</h2><p className="text-sm text-base-content/70">Send a goal to the existing conversation. Open Superterminal to follow the agent, send input or interrupt.</p>
    </div></header>
    <Notifications items={[{ message: error, onDismiss: () => setError('') }]} />
    <section className="card border border-base-300 bg-base-100 shadow-sm"><div className="card-body">
      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        <label className="flex flex-wrap items-center gap-2">Sandbox <select aria-label="Sandbox" className="select select-bordered" required value={uid} disabled={busy} onChange={(e) => setQuery({ sandbox: sandboxes.find(sandbox => sandbox.id === e.target.value)?.name || '', uid: e.target.value })}>
          <option value="">Select sandbox</option>{uid && !selectedSandbox && <option value={uid} disabled>Previous sandbox no longer exists. Select a sandbox.</option>}{sandboxes.map((sandbox) => <option key={sandbox.id} value={sandbox.id}>{sandbox.name}</option>)}
        </select></label>
        {selectedSandbox?.primaryReady === false && <p role="status" className="text-sm text-base-content/70">No ready primary agent. Open Superterminal to add an agent or send it a task.</p>}
        <label className="block">Prompt<textarea className="textarea textarea-bordered mt-2 w-full" name="prompt" required disabled={busy} /></label>
        <BusyButton className="btn-primary" busy={busy} disabled={!selectedSandbox || selectedSandbox.primaryReady === false}>Send task</BusyButton>
      </form>
      <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words" aria-live="polite">{output}</pre>
    </div></section>
  </>
}
